(function () {
    function switchTab(tab) {
        document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        var navItem = document.querySelector('.nav-item[data-tab="' + tab + '"]');
        var panel   = document.getElementById('tab-' + tab);
        if (navItem) navItem.classList.add('active');
        if (panel)   panel.classList.add('active');
        try { sessionStorage.setItem('er_tab', tab); } catch(e) {}
    }
    window.switchTab = switchTab;

    document.querySelectorAll('.nav-item[data-tab]').forEach(function (item) {
        item.addEventListener('click', function (e) {
            e.preventDefault();
            switchTab(item.dataset.tab);
        });
    });

    // Restore last active tab across page refreshes
    try {
        var saved = sessionStorage.getItem('er_tab');
        if (saved && document.getElementById('tab-' + saved)) switchTab(saved);
    } catch(e) {}
})();
