const navbar = `<header>
    <div class="wrap">
        <nav>
            <a class="logo" href="../index.html">
                <img src="../Silence-logo.png" alt="Silence" />
            </a>

            <div class="links">
                <a href="index.html">games</a>
                <a href="soundboard.html">soundboard</a>
                <a href="ai.html">ai</a>
                <a href="forms.html">forms</a>
                <a href="chat.html">chat</a>
                <a href="about.html">about</a>
                <a href="settings.html">settings</a>
            </div>
        </nav>
    </div>
</header>`

function createUpdateOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "update-overlay";
    overlay.className = "update-overlay";
    overlay.style.display = "none";

    overlay.innerHTML = `
        <div class="update-content" style="max-width:380px;padding:1.5rem 2rem;">
            <div class="update-header" style="border-bottom:none;padding-bottom:0;margin-bottom:1rem;">
                <span style="font-family:monospace;font-size:11px;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;" id="update-title">No title has been provided</span>
            </div>
            <p class="update-body" id="update-body">No description has been provided.</p>
            <div class="update-actions" style="justify-content:flex-start;margin-top:1.25rem;">
                <button class="update-btn" style="width:100%;" id="update-confirm">Ok</button>
            </div>
			<p class="update-meta" id="update-meta" style="margin-top:0.75rem;color:rgba(255,255,255,0.45);font-size:9px;">Unknown author</p>
        </div>
		`;

    document.body.appendChild(overlay);
}

document.addEventListener("DOMContentLoaded", async () => {
    const fragment = document.createRange().createContextualFragment(navbar);

    // the shell tags each iframe with its own page name (data-page)
    const page = window.frameElement?.dataset.page;

    if (page) {
        const link = fragment.querySelector(`.links a[href="${page}.html"]`);
        if (link) link.classList.add("on");
    }

    document.body.prepend(fragment);
    const credit = document.createElement("div");
    credit.className = "credit";
    credit.innerHTML = 'made by <a href="https://github.com/jumpingpantsmg/Silence" target="_blank" rel="noopener">jumpingpantsmg</a>';
    document.body.append(credit);

    const commits = await window.parent.checkforupdates();
    const latest = commits[0];
    const latestSha = latest.sha;
    const seenSha = localStorage.getItem('last_seen_commit');

    if (seenSha === latestSha) return;

    const fullMessage = latest.commit.message || '';
    const nlIdx = fullMessage.indexOf('\n');
    const title = nlIdx > -1 ? fullMessage.slice(0, nlIdx).trim() : fullMessage.trim();
    const body = nlIdx > -1 ? fullMessage.slice(nlIdx).trim() : '';

    const authorName = latest.commit.author?.name || 'Unknown';
    const dateRaw = latest.commit.author?.date || '';
    const dateFormatted = dateRaw ? new Date(dateRaw).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const shortSha = latestSha.slice(0, 7);

    if (!document.getElementById('update-overlay')) {
        createUpdateOverlay();
    }

    document.getElementById('update-title').textContent = title || 'Untitled update';
    document.getElementById('update-body').innerHTML = body
        ? parseMarkdown(body)
        : '<p style="color:var(--text-dim); font-style:italic;">No extended description provided.</p>';
    document.getElementById('update-meta').innerHTML =
        `<span> ${shortSha}</span> &nbsp;·&nbsp; ${authorName} &nbsp;·&nbsp; ${dateFormatted} `;

    document.getElementById('update-overlay').dataset.sha = latestSha;
    document.getElementById('update-overlay').style.display = 'flex';

    document.getElementById('update-confirm').onclick = () => {
        const overlay = document.getElementById('update-overlay');
        const sha = overlay.dataset.sha;
        if (sha) localStorage.setItem('last_seen_commit', sha);
        overlay.style.display = 'none';
    }
});