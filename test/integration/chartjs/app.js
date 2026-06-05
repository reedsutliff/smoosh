document.addEventListener('DOMContentLoaded', function() {
  // Highlight active nav
  document.querySelectorAll('.sidebar nav a').forEach(function(a) {
    var page = a.getAttribute('href').replace('.html', '');
    if (location.hash === '#' + page || (page === 'index' && !location.hash)) {
      a.classList.add('active');
    }
  });

  // Only render chart on the dashboard page
  var canvas = document.getElementById('revenueChart');
  if (!canvas || typeof Chart === 'undefined') return;

  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var data = [4200, 5100, 4800, 5900, 6300, 7100, 6800, 7500, 8200, 7900, 8600, 9400];

  var sum = data.reduce(function(a,b) { return a+b; }, 0);
  var avg = Math.round(sum / data.length);

  document.getElementById('totalValue').textContent = '$' + sum.toLocaleString();
  document.getElementById('avgValue').textContent = '$' + avg.toLocaleString();

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [{
        label: 'Revenue ($)',
        data: data,
        backgroundColor: 'rgba(102, 126, 234, 0.7)',
        borderColor: 'rgba(102, 126, 234, 1)',
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.06)' } },
        x: { grid: { display: false } }
      }
    }
  });
});
