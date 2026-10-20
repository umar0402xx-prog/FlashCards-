# A Level Recall — notes for Claude

Umar's flashcard app for Cambridge A Level revision (Nov 2027 series). It's a static, installable
web app served by GitHub Pages from this repo. Umar uses it on his Samsung phone, installed to the
home screen; it works offline.

## How it works

- `decks/index.json` lists the decks. `decks/<deck>.json` holds that deck's cards.
  **These are the files to edit when Umar asks for cards to be added, changed or removed.**
- Progress (spaced repetition), settings and any cards Umar makes on his phone are stored in his
  phone's browser (localStorage). Claude can't see them unless Umar pastes them into chat.
- `sw.js` caches everything for offline use. Decks are fetched network-first, so card changes show
  up next time he opens the app online (GitHub Pages can take a few minutes to update).
- **When you change any app file (`index.html`, `style.css`, `app.js`, `sw.js`, icons, vendor),
  bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` together.** Deck edits need no bump.

## Card format

```json
{ "id": "phy-0013", "topic": "Kinematics", "front": "Question", "back": "Answer" }
```

- `id` must be unique and must never change once published, because progress is keyed on it.
  Number new cards after the highest existing id in that deck: `phy-` Physics, `che-` Chemistry,
  `bio-` Biology. For a new deck, pick a short prefix and add the deck to `decks/index.json`
  (`id`, `name`, `code`, `color` from yellow, green, pink, blue, orange, lavender, `file`).
- Never reuse a deleted card's id. Retired so far (starter cards Umar asked to remove on 2026-10-20):
  `phy-0001`–`phy-0012`, `che-0001`–`che-0012`, `bio-0001`–`bio-0010`. So the next new ids are
  `phy-0013`, `che-0013` and `bio-0011`.
- Umar wants to make his own cards or ask for specific ones: don't add cards he hasn't asked for.
- Text supports `**key words**` (shown highlighted, like mark-scheme key words), line breaks (`\n`),
  maths with KaTeX between `$...$` (inline) or `$$...$$` (own line), and chemistry with mhchem
  (`$\ce{H2SO4}$`, `$\ce{N2 + 3H2 <=> 2NH3}$`). Remember to escape backslashes in JSON (`\\dfrac`).
- `topic` should use the Cambridge syllabus topic name.

## Content rules

- Syllabuses: Physics 9702, Chemistry 9701, Biology 9700 (Cambridge International A Level).
- Accuracy matters a lot: use Cambridge syllabus/mark-scheme wording for definitions, double-check
  every fact, unit and equation, and flag exam traps or common misconceptions on the back.
- Keep each card to one idea. Answers should read like a short mark-scheme answer with key words bolded.
- Use simple notation; avoid unnecessary Greek letters.

## Cards Umar made on his phone

In Settings, "Copy my cards for Claude" produces JSON with `"type": "my-cards"` and cards whose ids
start with `my-`. To merge them: add each card to the right deck file **keeping its `my-…` id
unchanged** (so his progress carries over; the app then removes the phone copy automatically).
If a card uses a deck id starting with `my-` that isn't in `decks/index.json`, add that deck too.
Check the content for accuracy before merging and tell Umar about anything you corrected.

## Checking changes

- Validate JSON: `python3 -m json.tool decks/physics.json > /dev/null`
- Check ids are unique across all decks before committing.
- Commit with a clear message and push to `main`; GitHub Pages deploys automatically.
