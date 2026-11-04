"""Browser end-to-end check against the three example dev servers.

Run the examples first (react :5171, html :5172, astro :4321), then:
    python3 test/e2e.py
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / "examples"
SHOTS = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(".")
fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def edit_inline(page, locator, new_text):
    locator.click()
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type(new_text)
    page.keyboard.press("Enter")


def edit_popover(page, locator, new_text):
    locator.click()
    inp = page.locator("copyedit-ui").locator(".pop input")
    inp.fill(new_text)
    inp.press("Enter")


def save(page):
    with page.expect_response(lambda r: "/__copyedit/apply" in r.url) as resp:
        page.keyboard.press("ControlOrMeta+s")
    return resp.value.json()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROME_PATH") or None)

    # ---------------------------------------------------------------- React
    print("react")
    page = browser.new_page()
    errors = []
    page.on("console", lambda m: m.type == "error" and "favicon" not in (m.location or {}).get("url", "") and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:5171/")
    page.wait_for_selector("h1")
    page.keyboard.press("Alt+e")
    check(page.evaluate("document.documentElement.hasAttribute('data-ce-on')"), "Alt+E turns edit mode on")

    edit_inline(page, page.locator("h1"), "Tiny tools for shared rooms")
    edit_inline(page, page.locator("nav a").first, "Read the long essay")
    check(page.url == "http://localhost:5171/", "clicking a link in edit mode does not navigate")
    edit_popover(page, page.locator("main button.btn"), "Get on the list")
    check(page.locator("main span").inner_text() == "0 joined", "button onClick suppressed in edit mode")
    # caret edit inside a paragraph that also contains an expression ({name})
    para = page.locator("main p").first
    para.click(position={"x": 2, "y": 8})
    page.keyboard.press("Home")
    page.keyboard.type("Oh, ")
    page.keyboard.press("Enter")
    page.screenshot(path=str(SHOTS / "react-pending.png"))
    data = save(page)
    statuses = [(r["status"], r.get("via")) for r in data["results"]]
    print("   ", statuses)
    check(all(s == "applied" for s, _ in statuses) and len(statuses) == 4, "all 4 React edits applied to source")
    app = (ROOT / "react/src/App.jsx").read_text()
    check("<h1>Tiny tools for shared rooms</h1>" in app, "h1 literal rewritten")
    check("label: 'Read the long essay'" in app, "data-array label rewritten (single quotes kept)")
    check("<Button onClick={() => setCount(count + 1)}>Get on the list</Button>" in app, "component children rewritten in App.jsx")
    check("\n        Oh, Hello {name}, this paragraph" in app, "partial JSXText edit keeps indentation and expression")
    page.wait_for_timeout(800)
    check(page.locator("h1").inner_text() == "Tiny tools for shared rooms", "HMR keeps the edited text")
    page.keyboard.press("Alt+e")
    page.locator("main button.btn").click()
    check(page.locator("main span").inner_text() == "1 joined", "edit mode off: button works again")
    check(not errors, f"no console errors ({errors[:2]})")
    page.close()

    # ---------------------------------------------------------------- HTML
    print("html")
    page = browser.new_page()
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    page.goto("http://localhost:5172/")
    page.wait_for_selector("h1")
    page.locator("copyedit-ui").locator(".pill").click()
    lede = page.locator("p.lede")
    lede.click(position={"x": 2, "y": 8})
    page.keyboard.press("Home")
    for _ in range(len("Tom & Jerry")):
        page.keyboard.press("Shift+ArrowRight")
    page.keyboard.type("Ann & Bo")
    page.keyboard.press("Enter")
    edit_popover(page, page.locator("form button"), "Send it now")
    check(not dialogs, "form submit suppressed in edit mode")
    edit_inline(page, page.locator("em"), "with care")
    page.screenshot(path=str(SHOTS / "html-pending.png"))
    data = save(page)
    print("   ", [(r["status"], r.get("via")) for r in data["results"]])
    html = (ROOT / "html/index.html").read_text()
    check('<p class="lede">Ann &amp; Bo made this <em>with care</em> on a quiet afternoon.</p>' in html, "HTML text nodes rewritten around inline <em>")
    check('<button type="submit">Send it now</button>' in html, "button text rewritten")
    page.wait_for_timeout(1200)
    check(page.locator("copyedit-ui").locator(".toast").is_visible(), "toast survives the full reload")
    page.screenshot(path=str(SHOTS / "html-saved.png"))
    page.close()

    # ---------------------------------------------------------------- Astro
    print("astro")
    page = browser.new_page()
    page.goto("http://localhost:4321/")
    page.wait_for_selector("h1")
    page.keyboard.press("Alt+e")
    edit_inline(page, page.locator("body > h1"), "Astro example 🌳")
    edit_inline(page, page.locator("body > p"), "Websites as places — open late")
    edit_inline(page, page.locator("article h2"), "Things I build")
    edit_inline(page, page.locator("ul li").first, "Computing shrines")
    edit_inline(page, page.locator("article p"), "Slotted text, edited.")
    data = save(page)
    print("   ", [(r["status"], r.get("via")) for r in data["results"]])
    src = (ROOT / "astro/src/pages/index.astro").read_text()
    check("<h1>Astro example 🌳</h1>" in src, "astro element text")
    check('const tagline = "Websites as places — open late";' in src, "frontmatter string")
    check('<Card title="Things I build">' in src, "component prop attribute")
    check('"Computing shrines"' in src, "array item in frontmatter")
    check("<p>Slotted text, edited.</p>" in src, "slotted text")
    page.close()

    # ---------------------------------------------------------------- queue
    print("queue")
    page = browser.new_page()
    page.goto("http://localhost:5171/")
    page.wait_for_selector("h1")
    page.keyboard.press("Alt+e")
    edit_inline(page, page.locator("main span"), "1 joined")  # "{count} joined" — dynamic
    data = save(page)
    print("   ", [(r["status"], r.get("reason")) for r in data["results"]])
    check(data["results"][0]["status"] == "queued", "dynamic text goes to the queue")
    q = (ROOT / "react/.copyedits.md").read_text()
    check("- after: \"1 joined\"" in q, "queue entry written")
    page.wait_for_timeout(300)
    check(not page.locator("copyedit-ui").locator(".tray").is_visible(), "queued edit leaves the tray")
    page.screenshot(path=str(SHOTS / "queue-toast.png"))
    page.close()
    browser.close()

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
