function greet(name) {
  return 'Hello, ' + name + '!';
}

function init() {
  var h1 = document.querySelector('h1');
  if (h1) {
    h1.textContent = greet('World') + ' — ' + h1.textContent;
  }
}

document.addEventListener('DOMContentLoaded', init);
