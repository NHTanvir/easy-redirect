document.addEventListener('DOMContentLoaded', function() {
    const redirectUrlInput = document.getElementById('redirectUrl');
    const newWebsiteInput = document.getElementById('newWebsite');
    const websiteListDiv = document.getElementById('websiteList');
    const statusDiv = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleBtn');

    // Load saved data
    loadData();

    // Event listeners
    document.getElementById('saveRedirectUrl').addEventListener('click', saveRedirectUrl);
    document.getElementById('addWebsite').addEventListener('click', addWebsite);
    document.getElementById('clearAll').addEventListener('click', clearAllWebsites);
    document.getElementById('toggleBtn').addEventListener('click', toggleExtension);
    
    // Enter key support
    newWebsiteInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            addWebsite();
        }
    });
    
    redirectUrlInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            saveRedirectUrl();
        }
    });

    async function loadData() {
        try {
            const result = await chrome.storage.sync.get(['redirectUrl', 'blockedWebsites', 'extensionEnabled']);
            
            redirectUrlInput.value = result.redirectUrl || 'https://www.google.com';
            
            const blockedWebsites = result.blockedWebsites || [];
            displayWebsites(blockedWebsites);
            
            const isEnabled = result.extensionEnabled !== false; // Default to true
            updateToggleButton(isEnabled);
        } catch (error) {
            showStatus('Error loading data: ' + error.message, 'error');
        }
    }

    async function saveRedirectUrl() {
        const url = redirectUrlInput.value.trim();
        
        if (!url) {
            showStatus('Please enter a redirect URL', 'error');
            return;
        }

        // Add protocol if missing
        let formattedUrl = url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            formattedUrl = 'https://' + url;
        }

        try {
            await chrome.storage.sync.set({ redirectUrl: formattedUrl });
            await updateRedirectRules();
            showStatus('Redirect URL saved successfully!', 'success');
            redirectUrlInput.value = formattedUrl;
        } catch (error) {
            showStatus('Error saving redirect URL: ' + error.message, 'error');
        }
    }

    async function addWebsite() {
        const website = newWebsiteInput.value.trim().toLowerCase();
        
        if (!website) {
            showStatus('Please enter a website', 'error');
            return;
        }

        try {
            const result = await chrome.storage.sync.get(['blockedWebsites']);
            let blockedWebsites = result.blockedWebsites || [];
            
            // Clean up the URL
            let cleanedWebsite = website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
            
            if (blockedWebsites.includes(cleanedWebsite)) {
                showStatus('Website already in the list', 'error');
                return;
            }
            
            blockedWebsites.push(cleanedWebsite);
            await chrome.storage.sync.set({ blockedWebsites });
            await updateRedirectRules();
            
            displayWebsites(blockedWebsites);
            newWebsiteInput.value = '';
            showStatus('Website added successfully!', 'success');
        } catch (error) {
            showStatus('Error adding website: ' + error.message, 'error');
        }
    }

    async function removeWebsite(website) {
        try {
            const result = await chrome.storage.sync.get(['blockedWebsites']);
            let blockedWebsites = result.blockedWebsites || [];
            
            blockedWebsites = blockedWebsites.filter(site => site !== website);
            await chrome.storage.sync.set({ blockedWebsites });
            await updateRedirectRules();
            
            displayWebsites(blockedWebsites);
            showStatus('Website removed successfully!', 'success');
        } catch (error) {
            showStatus('Error removing website: ' + error.message, 'error');
        }
    }

    async function clearAllWebsites() {
        if (confirm('Are you sure you want to remove all blocked websites?')) {
            try {
                await chrome.storage.sync.set({ blockedWebsites: [] });
                await updateRedirectRules();
                displayWebsites([]);
                showStatus('All websites cleared!', 'success');
            } catch (error) {
                showStatus('Error clearing websites: ' + error.message, 'error');
            }
        }
    }

    async function toggleExtension() {
        try {
            const result = await chrome.storage.sync.get(['extensionEnabled']);
            const isEnabled = result.extensionEnabled !== false;
            const newState = !isEnabled;
            
            await chrome.storage.sync.set({ extensionEnabled: newState });
            await updateRedirectRules();
            updateToggleButton(newState);
            
            showStatus(newState ? 'Extension enabled!' : 'Extension disabled!', 'success');
        } catch (error) {
            showStatus('Error toggling extension: ' + error.message, 'error');
        }
    }

    function updateToggleButton(isEnabled) {
        if (isEnabled) {
            toggleBtn.textContent = 'Disable Redirector';
            toggleBtn.classList.remove('disabled');
        } else {
            toggleBtn.textContent = 'Enable Redirector';
            toggleBtn.classList.add('disabled');
        }
    }

    function displayWebsites(websites) {
        if (websites.length === 0) {
            websiteListDiv.innerHTML = '<div style="text-align: center; color: #666; font-size: 12px;">No websites blocked</div>';
            return;
        }

        const websitesHtml = websites.map(website => `
            <div class="website-item">
                <span>${website}</span>
                <button class="remove-btn" onclick="removeWebsite('${website}')">Remove</button>
            </div>
        `).join('');

        websiteListDiv.innerHTML = websitesHtml;
    }

    async function updateRedirectRules() {
        try {
            const result = await chrome.storage.sync.get(['blockedWebsites', 'redirectUrl', 'extensionEnabled']);
            const blockedWebsites = result.blockedWebsites || [];
            const redirectUrl = result.redirectUrl || 'https://www.google.com';
            const isEnabled = result.extensionEnabled !== false;

            // Send message to background script to update rules
            chrome.runtime.sendMessage({
                action: 'updateRules',
                blockedWebsites: isEnabled ? blockedWebsites : [],
                redirectUrl: redirectUrl
            });
        } catch (error) {
            console.error('Error updating redirect rules:', error);
        }
    }

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.style.display = 'block';
        
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);
    }

    // Make removeWebsite available globally
    window.removeWebsite = removeWebsite;
});