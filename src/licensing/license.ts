/**
 * License Key System — Ed25519 signed license keys for OpenDescent Pro
 *
 * License keys are JSON payloads signed with a dedicated Ed25519 keypair.
 * The private key lives on the server (VPS), the public key is embedded
 * in every client. Verification is fully offline — no phone-home.
 *
 * Key format:
 *   { peerId, tier, issuedAt, expiresAt } + Ed25519 signature
 *
 * Wire format (user-facing):
 *   base64url( JSON({ payload, signature }) )
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LicenseTier = 'free' | 'pro';

export interface LicensePayload {
  peerId: string;
  tier: LicenseTier;
  issuedAt: number;    // Unix ms
  expiresAt: number;   // Unix ms
}

export interface License {
  payload: LicensePayload;
  signature: string;   // base64
}

export interface LicenseStatus {
  tier: LicenseTier;
  valid: boolean;
  expiresAt?: number;
  error?: string;
}

// ─── Tier Limits ────────────────────────────────────────────────────────────

export const TIER_LIMITS = {
  free: {
    maxFileSizeMB: 35,
    maxGroupMembers: 10,
    maxHubsCreated: 2,
    maxDeadManSwitches: 0,
    maxStorageMB: 512,
  },
  pro: {
    maxFileSizeMB: 500,
    maxGroupMembers: Infinity,
    maxHubsCreated: Infinity,
    maxDeadManSwitches: Infinity,
    maxStorageMB: 2048,
  },
} as const;

// ─── Licensing Public Key ───────────────────────────────────────────────────
// This is the PUBLIC key used to verify license signatures in every client.
// The corresponding private key lives ONLY on the licensing server.
// Generated once, never changes. If it changes, all existing licenses break.

// Embedded license verification key — generated once, never changes
const EMBEDDED_LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAzRrNpVAAqrfRW+IDB/sGeYDOvc8JYjUpEm42EUmLOOw=';
let LICENSE_PUBLIC_KEY: Buffer | null = Buffer.from(EMBEDDED_LICENSE_PUBLIC_KEY, 'base64');

/**
 * Set the license verification public key (DER-encoded SPKI).
 * Called once at startup from the embedded key.
 */
export function setLicensePublicKey(publicKeyBase64: string): void {
  LICENSE_PUBLIC_KEY = Buffer.from(publicKeyBase64, 'base64');
}

/**
 * Get the current license public key.
 */
export function getLicensePublicKey(): Buffer | null {
  return LICENSE_PUBLIC_KEY;
}

// ─── Server-side: Generate & Sign ───────────────────────────────────────────

/**
 * Generate a new Ed25519 keypair for license signing.
 * Run this ONCE to create the keypair, then embed the public key in clients.
 */
export function generateLicenseKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
  };
}

/**
 * Create a signed license key for a peer.
 * Server-side only — requires the private key.
 */
export function createLicense(
  peerId: string,
  tier: LicenseTier,
  durationMs: number,
  privateKeyBase64: string,
): string {
  const now = Date.now();
  const payload: LicensePayload = {
    peerId,
    tier,
    issuedAt: now,
    expiresAt: now + durationMs,
  };

  const payloadJson = JSON.stringify(payload);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const signature = crypto.sign(null, Buffer.from(payloadJson), privateKey);

  const license: License = {
    payload,
    signature: Buffer.from(signature).toString('base64'),
  };

  // Encode as base64url for easy copy-paste
  const json = JSON.stringify(license);
  return Buffer.from(json)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── Client-side: Verify ────────────────────────────────────────────────────

/**
 * Verify and decode a license key string.
 * Fully offline — uses the embedded public key.
 */
export function verifyLicense(licenseKey: string, expectedPeerId: string): LicenseStatus {
  if (!LICENSE_PUBLIC_KEY) {
    return { tier: 'free', valid: false, error: 'License system not initialized' };
  }

  try {
    // Decode base64url
    const padded = licenseKey.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const license: License = JSON.parse(json);

    // Verify signature
    const publicKey = crypto.createPublicKey({
      key: LICENSE_PUBLIC_KEY,
      format: 'der',
      type: 'spki',
    });

    const payloadJson = JSON.stringify(license.payload);
    const signatureBuffer = Buffer.from(license.signature, 'base64');
    const valid = crypto.verify(null, Buffer.from(payloadJson), publicKey, signatureBuffer);

    if (!valid) {
      return { tier: 'free', valid: false, error: 'Invalid license signature' };
    }

    // Check peer ID matches
    if (license.payload.peerId !== expectedPeerId) {
      return { tier: 'free', valid: false, error: 'License not issued for this peer' };
    }

    // Check expiry
    if (Date.now() > license.payload.expiresAt) {
      return { tier: 'free', valid: false, expiresAt: license.payload.expiresAt, error: 'License expired' };
    }

    return {
      tier: license.payload.tier,
      valid: true,
      expiresAt: license.payload.expiresAt,
    };
  } catch (err: any) {
    return { tier: 'free', valid: false, error: 'Invalid license key format' };
  }
}

/**
 * Check a specific tier limit against the current license.
 */
export function checkLimit(status: LicenseStatus, limit: keyof typeof TIER_LIMITS.free): number {
  const tier = status.valid ? status.tier : 'free';
  return TIER_LIMITS[tier][limit];
}
