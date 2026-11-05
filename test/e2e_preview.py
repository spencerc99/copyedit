"""Preview-mode browser test: edit a built preview, Copy edits, then `directedit apply`.

Build the examples as previews first (see README "Develop"), serve each dist folder, then:
    python3 test/e2e_preview.py
"""
import os, pathlib, subprocess, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = ROOT / "src" / "cli.js"
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(".")
fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def edit_inline(page, locator, text):
    locator.click()
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type(text)
    page.keyboard.press("Enter")


def run_apply(text, *args):
    return subprocess.run(["node", str(CLI), "apply", *args], input=text, text=True, capture_output=True, cwd=ROOT)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROME_PATH") or None)
    ctx = browser.new_context(permissions=["clipboard-read", "clipboard-write"])

    cases = [
        ("react", "http://localhost:4173/", lambda pg: [
            edit_inline(pg, pg.locator("h1"), "Tiny tools for shared rooms"),
            edit_inline(pg, pg.locator("nav a").first, "Read the long essay"),
        ], [("examples/react/src/App.jsx", "<h1>Tiny tools for shared rooms</h1>"),
            ("examples/react/src/App.jsx", "label: 'Read the long essay'")]),
        ("html", "http://localhost:4174/", lambda pg: [
            edit_inline(pg, pg.locator("h1"), "A hand-made HTML page"),
        ], [("examples/html/index.html", "<h1>A hand-made HTML page</h1>")]),
        ("astro", "http://localhost:4175/", lambda pg: [
            edit_inline(pg, pg.locator("body > h1"), "Astro example 🌳"),
            edit_inline(pg, pg.locator("article h2"), "Things I build"),
        ], [("examples/astro/src/pages/index.astro", "<h1>Astro example 🌳</h1>"),
            ("examples/astro/src/pages/index.astro", '<Card title="Things I build">')]),
    ]

    for name, url, do_edits, expect in cases:
        print(name)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_selector("h1")
        ui = page.locator("directedit-ui")
        check(ui.locator(".pill").is_visible(), "editor pill present in the preview build")
        page.keyboard.press("Alt+e")
        do_edits(page)
        check(ui.locator(".save").inner_text() == "Copy edits", "save button reads Copy edits")
        page.screenshot(path=str(SHOTS / f"preview-{name}-pending.png"))
        ui.locator(".save").click()
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / f"preview-{name}-copied.png"))
        text = page.evaluate("navigator.clipboard.readText()")
        check(text.startswith("Apply ") and "npx directedit apply <<'DIRECTEDIT'" in text, "clipboard holds the apply command")
        check(not ui.locator(".tray").is_visible(), "tray clears after copying")
        check(not errors, f"no page errors {errors[:2]}")

        wrong = run_apply(text)
        check(wrong.returncode == 1 and "git switch preview-test" in wrong.stderr, "refuses to apply on the wrong branch")
        subprocess.run(["git", "switch", "-q", "-c", "preview-test"], cwd=ROOT, check=True)
        try:
            ok = run_apply(text)
            print("   ", ok.stdout.strip().splitlines()[-1] if ok.stdout else ok.stderr)
            check(ok.returncode == 0, "apply exits 0 on the preview's branch")
            for f, needle in expect:
                check(needle in (ROOT / f).read_text(), f"{f} contains {needle!r}")
        finally:
            subprocess.run(["git", "checkout", "-q", "--", "examples"], cwd=ROOT)
            subprocess.run(["git", "switch", "-q", "main"], cwd=ROOT, check=True)
            subprocess.run(["git", "branch", "-q", "-D", "preview-test"], cwd=ROOT, check=True)
        page.close()
    browser.close()

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
