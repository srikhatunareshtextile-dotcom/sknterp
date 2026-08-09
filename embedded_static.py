import os

_dir = os.path.dirname(os.path.abspath(__file__))
css_file = os.path.join(_dir, "static", "css", "style.css")
js_file = os.path.join(_dir, "static", "js", "main.js")

STYLE_CSS_CONTENT = ""
if os.path.exists(css_file):
    try:
        with open(css_file, "r", encoding="utf-8") as f:
            STYLE_CSS_CONTENT = f.read()
    except Exception as e:
        print(f"Error reading style.css for fallback: {e}")

MAIN_JS_CONTENT = ""
if os.path.exists(js_file):
    try:
        with open(js_file, "r", encoding="utf-8") as f:
            MAIN_JS_CONTENT = f.read()
    except Exception as e:
        print(f"Error reading main.js for fallback: {e}")
