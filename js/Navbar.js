const navbar = `<header>
    <div class="wrap">
        <nav>
            <a class="logo" href="../index.html">
                <img src="../Silence-logo.png" alt="Silence" />
            </a>

            <div class="links">
                <a href="index.html">games</a>
                <a href="soundboard.html">soundboard</a>
                <a href="forms.html">forms</a>
                <a href="about.html">about</a>
                <a href="settings.html">settings</a>
            </div>
        </nav>
    </div>
</header>`

document.addEventListener("DOMContentLoaded", () => {
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
});