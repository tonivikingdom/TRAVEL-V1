# Mobile Web / Safari / Touch Interaction Hardening

Recommended model: GPT-5.6 Sol / Medium; alternative: available Sol. Raise effort if gestures conflict with draft protection or authority guards. This recommendation does not change the runtime model.

Starting main: `77b37ac1931b5ffe653bc147eebf90949258e94c`, fetched before work. Branch: `feat/mobile-safari-touch-hardening`. Quality and interaction work only; no new business capability. Draft delivery, no merge or deployment. The received task text ended during section 5; clarification was requested, and implementation stays within the received requirements and repository delivery rules.

## Inspection and scope

The original drawer was **C: an implemented pointer gesture**, not a decorative handle or browser-provided dismissal. Mobile pointer movement translated the dialog, with a 110px threshold and the existing `mayClose` callback. Small gestures bounced back; the dialog supplied native modal focus containment and the client locked body overflow. Original browser coverage already included drag, drafts, input focus, landscape, narrow screens, Today/Next, transport, saved Flight, backup and authoring.

Two regressions were reproduced on original production source before repair: a synthetic visual viewport shrinking to 360px at offset 40 left the dialog bottom at 844px; losing pointer capture left its 58px translation in place. The first launch attempt lacked Playwright's default Chromium executable and is not product-failure evidence. The subsequent system Chromium run reproduced both failures.

## Interaction changes

- Give the mobile handle region and close button at least 44px touch targets. Restrict drag initiation to a dedicated handle region, primary pointer and main button. Keep the 110px threshold and the unchanged dirty-draft/busy close callback. Reset translation and capture on cancellation/lost capture, close and content replacement. Buttons, inputs and the rest of the heading do not initiate drag; desktop does not require dragging.
- Fit open dialogs to the unzoomed VisualViewport height and bottom inset, including viewport offsets. Recompute on resize, rotation and focus; viewport scrolling updates bounds without repeatedly forcing focus back. Use native `scrollIntoView` and header-aware scroll padding to expose inputs above the keyboard and below the sticky header. Keep pinch zoom native rather than fitting to its magnified viewport.
- Preserve `vh` fallback and `dvh`, safe-area padding, native dialog scrolling and focus containment. Touch inputs have a scalable minimum 16px font to reduce Safari focus zoom; sheet titles/labels also scale with root text size.
- No new Provider, API, schema, migration, business command or cache. No change to backup/live authority gates, owner/session/version/idempotency protection, authoring receipts, in-trip reads or route Query/Preview/Adopt/Undo.

Migration delta **0**, total **26**.

## Verification

Final fixed-source local checks: frozen pnpm install, Prisma generate/validate, format, lint, full typecheck, Unit **754**, build, full Chromium **150**, and full WebKit **150** all passed. The original 140 cases per browser remain, with 10 additive quality regressions. Interrupted development runs during source updates are not passing evidence. Final-head PostgreSQL/Compose/P5B and combined browser CI results are recorded in the PR checks and final delivery report. Existing assertions are retained. New SYNTHETIC browser checks cover keyboard viewport shrink/restore and reachable save, lost capture bounce, native touch outside the handle, draft discard cancellation after dragging, scrolling without dismissal, touch Place/Authoring at 320/375/390/430px with actual 24px root font, Today/Transport rotation, landscape Backup and desktop detail.

The keyboard test overrides VisualViewport metrics and dispatches its resize event. It checks layout/focus and restoration, not the real iOS keyboard compositor. Touch contexts and WebKit automation do not establish physical iPhone acceptance. The existing full A/B/Backup suites retain owner isolation, failure states and save/draft/version/idempotency regressions.

## Visual evidence

All fixtures are **SYNTHETIC**. [JPEG contact sheet](assets/mobile-hardening/review-contact-sheet.jpg) preserves screenshot proportions and titles: RGB JPEG, quality 88, **1560 × 4960**, **493,380 bytes**. It was actually opened after final regeneration. PNG originals:

- [320px enlarged](assets/mobile-hardening/mobile-320-large-text.png)
- [375px enlarged](assets/mobile-hardening/mobile-375-large-text.png)
- [390px enlarged](assets/mobile-hardening/mobile-390-large-text.png)
- [430px enlarged](assets/mobile-hardening/mobile-430-large-text.png)
- [Today enlarged](assets/mobile-hardening/mobile-today.png)
- [Landscape transport](assets/mobile-hardening/landscape-transport.png)
- [Landscape backup](assets/mobile-hardening/landscape-backup.png)
- [Desktop](assets/mobile-hardening/desktop.png)

Artifacts are regenerated from final source and opened before commit. Scrolled form/transport screenshots deliberately show lower controls reachable; textarea text scrolls within its native control.

## Remaining limits

Physical iPhone, iOS Safari touch/overscroll, address-bar animation, actual software keyboard and OS accessibility settings remain **unverified**. Automated viewport offsets/sizes, WebKit and synthetic touch are bounded evidence. No embedded-map gesture acceptance is possible because embedded maps remain PARTIAL; external navigation behavior is unchanged. No gesture library, new business feature or complete offline app was added.

Hotel-only shortcut remains BLOCKED; Formal Place Search/geocoding is unfinished; Google Transit and embedded maps remain PARTIAL; real Provider/timetable/fare acceptance is outstanding. Static device backups are not encrypted device storage. No offline editing, background sync or backup history manager. F-05/F-06 remain OPEN. G/PR #41 and P6C are untouched.
