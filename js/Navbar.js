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

    const currentPage = window.parent.currentpage || '';
    const pageFile = currentPage === 'admin' ? 'index.html' : `${currentPage}.html`;
    const activeLink = currentPage && fragment.querySelector(`.links a[href="${pageFile}"]`);

    if (activeLink) activeLink.classList.add("on");

    document.body.prepend(fragment);
});