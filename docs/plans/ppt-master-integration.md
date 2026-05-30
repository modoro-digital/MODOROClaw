# PPT Master Integration Plan (v2.5.0)

**Status:** Brainstorming paused — Approach A selected, pending design spec.

## Decisions Made
- **Replace** pptxgenjs entirely (single code path)
- **Bundle** Python deps in runtime installer (~60-80MB, eager install)
- **Accept ~3 min** for 10-slide deck (quality > speed)
- **Approach A:** Full PPT Master as skill directory, LLM drives SVG→DrawingML pipeline

## Architecture Summary
- PPT Master (`skills/ppt-master/`) replaces `skills/anthropic-pptx/`
- Runtime installer downloads Python deps: `python-pptx`, `PyMuPDF`, `svglib`, `Pillow`, `reportlab`, `edge-tts`, `flask`, `mammoth`, `beautifulsoup4`, `markdownify`
- AGENTS.md routing: `pptx_create` → `skills/ppt-master/SKILL.md`
- LLM writes SVGs → `finalize_svg.py` → `svg_to_pptx.py` → `.pptx`
- No Playwright/Chrome/Node deps — pure Python

## Key Facts (from research)
- Repo: https://github.com/hugohe3/ppt-master (MIT, 22.1k stars)
- SVG→DrawingML: real PowerPoint shapes, not images
- Supports: animations, transitions, narration, charts
- Python 3.10+ required, ~60-80MB deps
- No browser dependency (cairosvg/svglib for PNG fallback)

## Next Steps (when resumed)
1. Finish brainstorming design spec
2. Write full spec doc → spec review loop
3. Create implementation plan via writing-plans skill
4. Implement in a feature branch
