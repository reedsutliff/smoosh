document.addEventListener('DOMContentLoaded', function() {
  // Highlight current nav
  const navLinks = document.querySelectorAll('.sidebar nav a');
  navLinks.forEach(function(link) {
    if (link.href.endsWith(window.location.pathname)) {
      link.classList.add('active');
    }
  });

  // Animate bars on load
  const bars = document.querySelectorAll('.bar');
  bars.forEach(function(bar) {
    var h = bar.style.height;
    bar.style.height = '0%';
    setTimeout(function() {
      bar.style.height = h;
    }, 100);
  });

  console.log('Dashboard ready ✓');
});
