document.querySelectorAll('.icon-card').forEach(card => {
  card.addEventListener('click', () => {
    card.classList.remove('clicked');
    // Force reflow so animation restarts if clicked twice
    void card.offsetWidth;
    card.classList.add('clicked');
    setTimeout(() => card.classList.remove('clicked'), 2000);
  });
});
