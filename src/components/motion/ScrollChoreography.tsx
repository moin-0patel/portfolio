import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useEffect } from 'react'

import { CHAPTERS, type ChapterId } from '@/lib/chapters'
import { buildChapterBands, type SectionMeasurement } from '@/lib/chapterTimeline'

/**
 * Phase 4 — the DOM half of the choreography, motion spec section 3.1.
 *
 * The scene's timeline lives in the render loop (see ScrollDirector); this is
 * everything made of text. They are separate on purpose: three.js objects want
 * to be written inside a frame, and DOM elements want a library that already
 * knows about trigger positions, resize refreshes and transform batching.
 *
 * WHY GSAP EARNS ITS PLACE HERE AND NOT IN THE SCENE
 *
 * ScrollTrigger solves the parts that are tedious and easy to get subtly wrong:
 * per-element start positions, recalculating them when the layout reflows or an
 * async section finishes loading, and batching writes so thirty reveals do not
 * each force their own layout. Reimplementing that against the existing scroll
 * hook would be a worse ScrollTrigger. Inside the canvas it would be the
 * opposite trade — GSAP's ticker runs between frames, so it would write to
 * three.js objects the renderer had already read.
 *
 * NOT MOUNTED UNDER REDUCED MOTION
 *
 * A11Y-10 and spec section 7. The guard is at the call site rather than an
 * early return here, so under `prefers-reduced-motion` this module's inline
 * styles are never applied at all — the page renders at its natural final
 * state. An early return would still leave whatever GSAP had already set.
 *
 * THE NON-NEGOTIABLE — spec section 11.2
 *
 * "Nothing is revealed only by scrolling. Scroll changes emphasis, never
 * availability." Reveals fire at `top 85%`, so an element begins animating
 * before it is fully on screen and is finished by the time it can be read.
 * Content is in the HTML from first paint either way; if this module fails to
 * load, nothing is ever set to `opacity: 0` and the page reads normally.
 */

gsap.registerPlugin(ScrollTrigger)

/**
 * THE REVEAL, RE-MEASURED OFF THE LIVE REFERENCE.
 *
 * Every value here replaced a guess, and the guess it replaced was wrong in a
 * specific and instructive way. Phase 0 scanned computed styles for transition
 * declarations, found `transform, opacity` at `0.4s / 0.2s` on
 * `cubic-bezier(0.25, 0.46, 0.45, 0.94)`, and recorded it as the reference's
 * reveal. Re-measured: that spec is carried by seven elements and the
 * representative one is `DIV.popup-card-wrap`. It is the POPUP transition. The
 * reference's scroll reveals are GSAP-driven and never touch a CSS transition,
 * so a scan of computed styles could not see them by construction.
 *
 * These numbers come from sampling the animated properties frame by frame,
 * driven with real wheel events, on a text line travelling one line-height:
 *
 *   DURATION 0.6s. Solving five independent sample points for duration under a
 *   cubic ease-out gives 582, 595, 600, 601 and 603ms. Under a quadratic ease
 *   the same points give 406, 432, 461 and 500ms — drifting upward, because
 *   power2 cannot produce the tail the reference actually has. The old value
 *   was 0.7s.
 *
 *   EASE power3.out, which is that cubic ease-out. Was power2.out.
 *
 *   NO BLUR. `filter` reads `none` on every reference element, before and
 *   during its reveal. The old `blur(8px)` was invented here, and it is also
 *   the most expensive part of the tween — it forces a filter pass per frame
 *   on text.
 *
 *   STAGGER 0.105s, measured at 102, 102 and 112ms between consecutive
 *   siblings across two parallel groups. Was 0.08.
 *
 * WHAT IS NOT COPIED, AND WHY
 *
 * The reference's text reveal is a MASKED slide: the line sits at
 * translateY(1 line-height) inside an `overflow: hidden` parent and rides up
 * with opacity pinned at 1 — it is never faded. Reproducing that means wrapping
 * every revealing line in a clipping element, which changes the DOM of every
 * text block on the page and risks clipping descenders and focus rings. That is
 * a layout change, not a motion one, so this keeps a fade-and-rise and takes
 * the reference's timing, easing and stagger. The distance stays 40px: the
 * reference travels one line-height, which is 27-66px depending on the element.
 */
const REVEAL_FROM = { opacity: 0, y: 40 }
const REVEAL_TO = { opacity: 1, y: 0, ease: 'power3.out', duration: 0.6 }

/** Seconds between revealing siblings — see above. */
const STAGGER = 0.105

/**
 * The most a group's stagger may spread, in seconds — and the reason it exists
 * is that the measured 105ms was measured between FIVE siblings.
 *
 * Applied naively to the Process chapter's 27 targets, 105ms each is a 2.8s
 * queue before the last element even starts, and this module's own
 * non-negotiable is that a reveal is finished by the time the content can be
 * read. Verified live: after a full settle, Process still had paragraphs at
 * opacity 0.0-0.9 sitting in the middle of the viewport.
 *
 * The reference never staggers a group that large — its biggest measured group
 * is five lines, a 420ms spread. So the per-sibling gap holds at 105ms for
 * groups up to ~7 and compresses beyond that, keeping the total spread at what
 * the reference's own largest group actually spends.
 */
const STAGGER_MAX_SPREAD = 0.63

/** 105ms between siblings, until the group is large enough to cap. */
const staggerFor = (count: number) =>
  count > 1 ? Math.min(STAGGER, STAGGER_MAX_SPREAD / (count - 1)) : 0

export function ScrollChoreography() {
  useEffect(() => {
    let context: gsap.Context | null = null
    let cancelled = false

    /*
     * Build the timeline only once the page has stopped growing.
     *
     * Sections fetch their own data, and Featured Projects in particular
     * renders a skeleton first. Setting up against that shorter page meant its
     * cards did not exist yet, so no tween was ever created for them and
     * chapter 04's text simply never animated — measured at opacity 1.00 while
     * every other chapter started at 0.00. Refreshing ScrollTrigger does not
     * help: refresh recalculates positions for tweens that exist, it does not
     * discover new elements.
     *
     * `aria-busy` is already the app's own signal for "this region is still
     * loading" — the same one verify:ui waits on — so this reuses it rather
     * than inventing a second convention.
     */
    const build = () => {
      if (cancelled) return
      context = gsap.context(() => {
        /*
         * The same section geometry the scene uses — see chapterTimeline.ts.
         *
         * Chapter 02's line sequence has to run on the same clock as the
         * camera's closest approach, and that clock is now "where the
         * introduction section actually is", not a share of document height.
         * Measured inside the getter so ScrollTrigger's refresh picks up a
         * reflow rather than caching a boundary computed at first paint.
         */
        const measuredBand = (chapter: ChapterId) => {
          const sections: SectionMeasurement[] = []
          for (const id of CHAPTERS) {
            const el = document.querySelector<HTMLElement>(`[data-chapter="${id}"]`)
            if (!el) continue
            const rect = el.getBoundingClientRect()
            sections.push({ chapter: id, top: rect.top + window.scrollY, height: rect.height })
          }
          const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
          const bands = buildChapterBands(sections, window.innerHeight, maxScroll)
          return bands.find((b) => b.chapter === chapter) ?? { enter: 0, exit: maxScroll }
        }

        /*
         * Chapter 02 — the four statement lines, scrubbed.
         *
         * The one place text replaces itself, and the spec is emphatic about why:
         * "four statements stacked on screen at once is a paragraph, and a
         * paragraph is not a statement." Sub-beat table, section 4, chapter 02:
         * each line owns a quarter, lines 1-3 leave, line 4 stays and carries
         * into chapter 03.
         */
        const lines = gsap.utils.toArray<HTMLElement>('[data-line]')
        if (lines.length > 0) {
          /*
           * Bound to the CHAPTER RANGE, not to the section's own geometry.
           *
           * The first version triggered on the section box — start "top top",
           * end "bottom bottom" — and the introduction is short, so the whole
           * four-line sequence finished within a couple of hundred pixels and
           * was already over by the time the document reached 20% progress. The
           * scene, which reads CHAPTER_RANGES directly, was still early in
           * chapter 02. Text and camera were choreographing different moments.
           *
           * Section 1 allocates chapter 02 to 12-28% of document progress, so
           * that is what this scrubs against: the same clock the Core runs on,
           * which is the whole point of the statement landing while the camera
           * makes its closest approach.
           */
          const band = () => measuredBand('introduction')

          /*
           * ONE timeline for all four lines, not one each.
           *
           * Four separate timelines were four separate clocks: ScrollTrigger
           * normalises each timeline's own total duration across the same
           * scroll range, so line 1's timeline (0.25s long) and line 4's
           * (0.98s) mapped the identical scroll span onto completely different
           * schedules. Line 1's exit, specified at 25% of the chapter, actually
           * played at 88% of it — the lines overlapped instead of replacing one
           * another, which is precisely the "paragraph, not a statement"
           * failure the spec calls out.
           *
           * Sharing one timeline makes the positions below mean what the
           * sub-beat table says they mean.
           */
          const timeline = gsap.timeline({
            scrollTrigger: {
              trigger: document.documentElement,
              start: () => band().enter,
              end: () => band().exit,
              scrub: 0.6, // section 3.4 — the same smoothing lag as the scene
              // The page's height changes as sections load and as the viewport
              // resizes; without this the pixel positions are computed once and
              // then quietly wrong.
              invalidateOnRefresh: true,
            },
          })

          lines.forEach((line, index) => {
            const share = 1 / lines.length
            const at = index * share
            const isLast = index === lines.length - 1

            // Section 4, chapter 02 sub-beats. At four lines these evaluate to
            // the table's own numbers: in over 0.00-0.08, out over 0.22-0.25,
            // and the same shape a quarter later for each subsequent line.
            timeline.fromTo(line, REVEAL_FROM, { ...REVEAL_TO, duration: share * 0.32 }, at)

            if (!isLast) {
              // Lines 1-3 recede so the next one lands alone. Section 3.1
              // reversed: out is opacity 1 -> 0.
              //
              // `blur(6px)` removed here for the same reason it was removed
              // from REVEAL_TO: the reference carries `filter: none` on every
              // element through every reveal, so the blur was ours rather than
              // its. It is also the one property in this tween that forces a
              // per-frame filter pass, and this tween is SCRUBBED — it runs on
              // every scroll event rather than once.
              timeline.to(
                line,
                { opacity: 0, y: -20, ease: 'power3.out', duration: share * 0.12 },
                at + share * 0.88,
              )
            }
          })

          // Pin the timeline's end to 1 so the positions above are fractions of
          // the chapter, not of whatever the last tween happened to finish at.
          timeline.set({}, {}, 1)
        }

        /*
         * Chapter 03 — the four capability cards, revealed one at a time.
         *
         * `data-capability` carries the index, so the stagger follows the source
         * order rather than whatever order the grid happens to lay them out in at
         * this breakpoint. Divided by the number of cards, not by four: section 9
         * forbids hard-coding the count, and capabilities.ts is free to grow.
         */
        const capabilities = gsap.utils.toArray<HTMLElement>('[data-capability]')
        if (capabilities.length > 0) {
          gsap.fromTo(capabilities, REVEAL_FROM, {
            ...REVEAL_TO,
            // The card grid beats at double the text stagger, as before, but
            // through the same cap so a future fifth card cannot stretch it.
            stagger: Math.min(STAGGER * 2, staggerFor(capabilities.length) * 2),
            scrollTrigger: { trigger: capabilities[0], start: 'top 85%', once: true },
          })
        }

        /*
         * The journey cards — the reference's `.about-card` reveal.
         *
         * Measured on the live site: each card enters at opacity 0,
         * scale(0.6), translated down ~34px, and settles over roughly 1.2s of
         * damped, scroll-coupled motion. That mechanism (a scrubbed spring) is
         * not this module's grammar, so the card takes the shared entrance
         * tween instead — same values as everything else — plus the scale the
         * reference demonstrably has. 0.94 rather than 0.6: the reference
         * spreads its growth over a damped 1.2s, and 0.6 compressed into a
         * 600ms entrance reads as a pop it does not have.
         *
         * Experience is not a chapter (the chapter list drives the 3D scene's
         * camera bands and is not to be re-cut for a reveal), so this is the
         * same explicit opt-in `data-capability` uses. This is also the
         * extension point the chapter-loop comment promised Journey.
         */
        /*
         * THE HERO MORPH — Phase 6, the continuous scroll composition.
         *
         * The forensic pass over the reference recording (2026-08-30) showed
         * its hero does not scroll away: it DISASSEMBLES. The wordmark shrinks
         * into a compact top-left mark, the headline drifts up and aside, the
         * portrait scales up, holds the stage, and then fades into an
         * atmospheric layer while the next section slides in over it. The
         * earlier parallax exit (2026-08-30, one viewport of lag) was the
         * first approximation; this replaces it.
         *
         * MECHANISM. `hero-morph-scene` (added here, styled in globals.css)
         * grows the section to 250svh, makes the composition wrapper a sticky
         * 100svh stage, and pulls the following section up 100svh. This
         * timeline then scrubs across the scene's 150svh of travel. Adding
         * the class HERE keeps the standing failure contract: reduced motion
         * never mounts this module, prerendered HTML never carries the class,
         * and if this chunk fails to load the hero stays a plain viewport.
         *
         * The class must be added BEFORE any ScrollTrigger is created — it
         * changes the document's geometry, and every trigger below measures
         * against that geometry. The chapter timeline re-measures on its own
         * (ResizeObserver on the sections), so the 3D camera's hero band
         * stretches to cover the scene without any change there.
         *
         * SAFETY, same two metrics as ever:
         *   LCP — every tween holds identity at progress 0, the first paint
         *   stays byte-identical to the boot shell, and the class only grows
         *   the document BELOW the fold;
         *   CLS — transform/opacity only; the section's overflow-hidden
         *   clips the wordmark's travel.
         *
         * `ease: 'none'` throughout — the scrub's damping is the easing.
         */
        const hero = document.querySelector<HTMLElement>('[data-chapter="hero"]')
        if (hero && hero.querySelector('[data-hero-composition]')) {
          hero.classList.add('hero-morph-scene')

          /*
           * THE RAIL (Phase 6, owner decision 2026-08-31). From lg the site's
           * chrome is the reference's persistent left rail, and on Home it
           * FORMS out of this morph: SiteRail renders `rail-home`
           * (display:none) so the rest state is the signed-off header-only
           * composition, this build lifts it, and the timeline below fades
           * the header out while the rail's items stagger in — the recording's
           * chrome handoff. Desktop-only: below lg there is no rail and the
           * header keeps its place through the morph, exactly as shipped.
           * Breakpoint is sampled at build; crossing 1024px mid-session takes
           * a reload to re-arm, which matches the module's general contract.
           */
          const railDesktop = window.matchMedia('(min-width: 1024px)').matches
          const rail = document.querySelector<HTMLElement>('[data-rail]')
          const railLogo = rail?.querySelector<HTMLElement>('[data-rail-logo]') ?? null
          if (railDesktop && rail) rail.classList.remove('rail-home')
          const railActive = Boolean(railDesktop && rail)

          const morph = gsap.timeline({
            defaults: { ease: 'none' },
            scrollTrigger: {
              trigger: hero,
              start: 'top top',
              // 'bottom bottom': progress completes as the scene's last
              // viewport arrives — which, via the -100svh margin, is exactly
              // when the next section has fully climbed over the stage.
              end: 'bottom bottom',
              scrub: 0.6,
              invalidateOnRefresh: true,
            },
          })

          const wordmark = hero.querySelector<HTMLElement>('[data-hero-wordmark]')
          const figure = hero.querySelector<HTMLElement>('[data-hero-figure]')
          const plate = hero.querySelector<HTMLElement>('[data-hero-recede]')
          const headline = hero.querySelector<HTMLElement>('[data-hero-headline]')
          const ctas = hero.querySelector<HTMLElement>('[data-hero-ctas]')
          const aside = hero.querySelector<HTMLElement>('[data-hero-aside]')

          /*
           * WORDMARK -> COMPACT MARK. Scale + translate only, measured from
           * the element's own box at build (and re-measured on refresh), so
           * every viewport derives its own end state — no hard-coded desktop
           * pixels. The end scale targets a ~44px-tall mark; the translate
           * parks its left edge at the content gutter, just under the fixed
           * header, where the reference parks its logo. transformOrigin is
           * the element's top-left so the arithmetic is plain rect algebra.
           */
          if (wordmark) {
            gsap.set(wordmark, { transformOrigin: 'left top' })
            /*
             * All getters use LAYOUT metrics (offsetHeight, scrollWidth,
             * viewport size), never getBoundingClientRect: rects are
             * contaminated by the in-flight transform and the scroll position
             * when invalidateOnRefresh re-runs these mid-scroll; layout
             * metrics are transform-independent, so a refresh at any scroll
             * position derives the same end state.
             */
            /*
             * TIMING, retuned 2026-08-31 against a frame-by-frame read of the
             * reference recording (2fps burst over the transition): the
             * REORGANISATION IS FAST — the wordmark reaches its compact end
             * state within roughly the first third of the scene's travel —
             * and the mark then persists at FULL opacity for the rest of the
             * scroll (it becomes the reference's permanent corner logo). The
             * first cut of this timeline spread the shrink across the whole
             * scene and dimmed the mark to 0.4 at the end; both read wrong
             * against the recording.
             */
            /*
             * END STATE, two variants. With the rail (lg): the wordmark
             * shrinks INTO the rail's logo slot — same left, same top, same
             * height — and the crossfade below swaps them at landing, so the
             * giant hero name literally becomes the rail logo. The rail is
             * `position: fixed`, so its rects are scroll-stable and safe in
             * refresh-time getters. Without the rail (tablet morph): the
             * legacy corner mark, 24px gutter, 16px under the 64px header.
             */
            morph.to(
              wordmark,
              {
                scale: () => {
                  if (railActive && railLogo)
                    return Math.max(
                      0.04,
                      railLogo.offsetHeight / Math.max(1, wordmark.offsetHeight),
                    )
                  return Math.min(0.35, 44 / Math.max(1, wordmark.offsetHeight))
                },
                x: () => {
                  // The span is inset-x-0 with centred, overflowing text: its
                  // painted left edge sits at (viewport - text width) / 2,
                  // usually negative.
                  const paintedLeft = (window.innerWidth - wordmark.scrollWidth) / 2
                  if (railActive && railLogo)
                    return railLogo.getBoundingClientRect().left - paintedLeft
                  return 24 - paintedLeft
                },
                // The stage is stuck at the viewport top throughout the
                // morph, so stage coordinates ARE viewport coordinates; the
                // wordmark's layout top is 7% of the 100svh stage.
                y: () => {
                  if (railActive && railLogo)
                    return railLogo.getBoundingClientRect().top - window.innerHeight * 0.07
                  return 64 + 16 - window.innerHeight * 0.07
                },
                duration: 0.38,
              },
              0,
            )
            // No opacity tween here: the mark never dims. With the rail, the
            // crossfade below replaces it with the rail's own logo instead.
          }

          /*
           * RAIL FORMATION + CHROME HANDOFF (lg only). Items are armed
           * hidden, stagger in through the reorganisation, and the top
           * header fades out as they arrive. The logo slot stays empty until
           * the shrinking wordmark lands on it (0.36-0.45), then the two
           * crossfade — scrubbed, so scrolling back up hands the chrome
           * back and reassembles the giant name.
           */
          if (railActive && rail) {
            /*
             * Armed at the CONTAINER, not per item: the rail's blurb, email
             * and availability mount only after their queries resolve, and a
             * per-item gsap.set taken at build time missed whichever of them
             * arrived late — they floated over the hero at rest. Hiding the
             * container gates every child, present or future; the per-item
             * stagger below targets only the nav links, which are static and
             * guaranteed to exist at build.
             */
            gsap.set(rail, { autoAlpha: 0 })
            if (railLogo) gsap.set(railLogo, { autoAlpha: 0 })
            const railLinks = gsap.utils.toArray<HTMLElement>(rail.querySelectorAll('nav a'))
            gsap.set(railLinks, { autoAlpha: 0, y: 12 })

            const headerEl = document.querySelector<HTMLElement>('header')
            if (headerEl) morph.to(headerEl, { autoAlpha: 0, duration: 0.18 }, 0.08)
            morph.to(rail, { autoAlpha: 1, duration: 0.2 }, 0.14)
            morph.to(railLinks, { autoAlpha: 1, y: 0, duration: 0.26, stagger: 0.02 }, 0.18)
            if (railLogo) {
              morph.to(railLogo, { autoAlpha: 1, duration: 0.07 }, 0.36)
              if (wordmark) morph.to(wordmark, { autoAlpha: 0, duration: 0.07 }, 0.38)
            }
          }

          /*
           * PORTRAIT DISSOLVE — corrected 2026-09-01 against the LIVE
           * reference, measured with real wheel input on heynesh.com.
           *
           * The earlier ruling here ("no blur — the recording's blur is a
           * privacy edit") was WRONG. The live site's portrait is a fixed
           * layer that progressively blurs with scroll — ~12px within the
           * first 160px of travel, ~50px by half a viewport, capping at
           * blur(90px) — while opacity eases 1 -> 0.30, and it then PERSISTS
           * at that 90px/0.30 atmospheric wash for the entire page. It never
           * translates and never scales (the 1.001 is the known static
           * artifact). The Phase 0 stills only looked sharp because they were
           * sampled at rest, where the blur is genuinely 0.
           *
           * Ours adapts rather than copies the numbers: the reference's
           * portrait is a full-viewport backdrop, ours is THE subject — a
           * ~500px cut-out — so 90px would annihilate it. The owner's brief
           * asks for it to stay recognisable through the majority of the
           * transition, so the dissolve is staged: gentle (6px) through the
           * reorganisation, deepening as the headline exits, and only
           * reaching its heaviest step with the final opacity drop to the
           * reference's measured 0.30 floor — by which point the statement
           * is rolling over it and the blur actively helps that text read.
           * Mobile keeps roughly half the radius and a higher floor: at
           * 390px the figure fills most of the frame and a heavy blur wipes
           * the composition instead of dissolving it.
           *
           * Blur is applied to this one wrapper only — never the section,
           * never text — and will-change is declared at arm time so the
           * filter gets its own layer instead of repainting the stage.
           */
          if (figure) {
            const softBlur = !window.matchMedia('(min-width: 1024px)').matches
            gsap.set(figure, {
              transformOrigin: 'center bottom',
              filter: 'blur(0px)',
              willChange: 'filter, opacity, transform',
            })
            morph.to(figure, { scale: 1.06, duration: 0.4 }, 0)
            morph.to(figure, { filter: softBlur ? 'blur(3px)' : 'blur(6px)', duration: 0.3 }, 0.2)
            morph.to(figure, { filter: softBlur ? 'blur(8px)' : 'blur(16px)', duration: 0.25 }, 0.5)
            morph.to(
              figure,
              {
                filter: softBlur ? 'blur(13px)' : 'blur(26px)',
                opacity: softBlur ? 0.4 : 0.3,
                duration: 0.25,
              },
              0.75,
            )
          }

          // Identity plate: the spec's §4 ch01 recede, early in the morph.
          if (plate) morph.to(plate, { opacity: 0.15, y: -30, duration: 0.35 }, 0)

          /*
           * HEADLINE: the recording's headline never dims in place — it rides
           * UP to the top band beside the shrinking wordmark, fully legible
           * (the "NESH® / Applied Differently." title row), and then EXITS
           * off the top edge as About arrives. Two phases here: the ride
           * (opacity 1 throughout), then the exit — translate past the top,
           * fading only as it leaves. The <p> and its tokens are untouched.
           */
          if (headline) {
            morph.to(
              headline,
              {
                y: () => -window.innerHeight * 0.52,
                x: () => window.innerWidth * 0.16,
                scale: 0.55,
                duration: 0.38,
              },
              0.02,
            )
            // The fade LEADS the travel: opacity reaches 0 while the line is
            // still in the stage's upper third, so it never crosses the fixed
            // header half-visible (the reference has no chrome to cross — its
            // header is the rail the morph is building).
            morph.to(headline, { y: () => -window.innerHeight * 0.85, duration: 0.3 }, 0.66)
            morph.to(headline, { autoAlpha: 0, duration: 0.14 }, 0.66)
          }

          /*
           * CTAs and the right band: the reference keeps its call-to-action
           * alive almost to the end (it migrates into the rail and never
           * dies). Without a rail to receive them, ours stay interactive
           * until the incoming section is about to cover the stage, then
           * autoAlpha out — visibility:hidden at 0 removes them from the tab
           * order and pointer reach under the overlap.
           */
          if (ctas) morph.to(ctas, { autoAlpha: 0, duration: 0.18 }, 0.8)
          if (aside) morph.to(aside, { autoAlpha: 0, duration: 0.18 }, 0.8)
        }

        const journeyCards = gsap.utils.toArray<HTMLElement>('[data-journey-card]')
        for (const card of journeyCards) {
          /*
           * SCRUBBED PER CARD, which is the reference's actual mechanism.
           *
           * The measured `.about-card` enters at opacity 0, scale 0.6 and
           * ~34px down, then settles over roughly 1.2s of damped motion that
           * is COUPLED TO SCROLL — scrolling back up plays it backwards. The
           * previous once-fired group tween could not do that: it played one
           * fixed 600ms entrance and then stayed put forever.
           *
           * `scrub: 1.2` is the damping. GSAP eases the playhead toward the
           * scroll position over 1.2s rather than binding frame-for-frame,
           * which is what produces the spring-like settle instead of a value
           * that tracks the wheel exactly.
           *
           * Per card, not one tween over the group: each card owns its own
           * trigger window, so the second card is not already finished by the
           * time it enters the viewport (which is what a shared trigger does
           * to a tall stacked list). The stagger falls out of the geometry.
           *
           * SAFE FOR RES-12: scale only ever approaches 1 from below and the
           * travel is vertical, so nothing can widen the document.
           */
          gsap.fromTo(
            card,
            { opacity: 0, y: 34, scale: 0.6 },
            {
              opacity: 1,
              y: 0,
              scale: 1,
              ease: 'power2.out',
              scrollTrigger: {
                trigger: card,
                /*
                 * A TIGHT window low in the viewport — retuned 2026-08-31.
                 * The first cut ran 92% -> 55%: a third of a viewport of
                 * scroll during which the card lagged its slot, and a
                 * lagging card SINKS relative to the content around it —
                 * the owner saw the journey "going downwards" where the
                 * reference rises. In the recording the ghost enters just
                 * below its resting place and pops up crisply while still
                 * in the lower quarter of the screen; 96% -> 78% with
                 * lighter damping reproduces that read, still fully
                 * scrubbed and reversible.
                 */
                start: 'top 96%',
                end: 'top 78%',
                scrub: 0.8,
                invalidateOnRefresh: true,
              },
            },
          )
        }

        /*
         * THE WORK BRIDGE — cream to #131313 and back, scrubbed.
         *
         * The dark Work plate is OUR measured decision, not the reference's:
         * the live site stays cream end to end (measured 2026-09-01, wheel
         * sweep at 10-60% of the document). The owner keeps the plate, so the
         * hard edge is what goes: the ground darkens as the section
         * approaches — mostly dark before the heading's own reveal fires at
         * 85% — and lightens again only as its bottom leaves, when the cards
         * are already above the fold. Two fromTo tweens on one property with
         * immediateRender off: each owns its scroll window, the inline value
         * between them is the plate's own #131313, and both reverse cleanly.
         * Everything inside the section (cards, scrim, CTA disc, type) is
         * untouched.
         */
        const work = document.querySelector<HTMLElement>('#featured-projects')
        if (work && work.classList.contains('work-ground')) {
          gsap.fromTo(
            work,
            { backgroundColor: '#d5cfbe' },
            {
              backgroundColor: '#131313',
              ease: 'none',
              immediateRender: false,
              scrollTrigger: {
                trigger: work,
                start: 'top 98%',
                end: 'top 68%',
                scrub: 0.5,
                invalidateOnRefresh: true,
              },
            },
          )
          gsap.fromTo(
            work,
            { backgroundColor: '#131313' },
            {
              backgroundColor: '#d5cfbe',
              ease: 'none',
              immediateRender: false,
              scrollTrigger: {
                trigger: work,
                start: 'bottom 45%',
                end: 'bottom 2%',
                scrub: 0.5,
                invalidateOnRefresh: true,
              },
            },
          )
        }

        /*
         * Every other chapter — headings and copy, staggered on entry.
         *
         * Scoped to `[data-chapter]`, which excludes the hero: FR-HOME-02 owns
         * the hero's own reveal (<=700ms, 70ms intervals) and the owner's ruling
         * kept that clause with the PRD rather than handing it to this timeline.
         * The hero is also the one composition already approved and verified;
         * animating it here would put it back in play.
         */
        const reveal = (section: HTMLElement) => {
          const all = gsap.utils
            .toArray<HTMLElement>(section.querySelectorAll('h2, h3, p, li, a'))
            // Capability and journey cards have their own beats above;
            // animating their contents twice would leave whichever tween
            // finished last holding the opacity.
            .filter((el) => !el.closest('[data-capability]') && !el.closest('[data-journey-card]'))

          /*
           * THE HEADING SLIDES BEHIND A MASK; everything else fades and rises.
           *
           * The module header records why the fade was chosen originally — the
           * reference's reveal is a masked slide, and reproducing it needed a
           * clipping wrapper around every revealing line. That objection holds
           * for body copy, which is why body copy still fades. It does NOT
           * hold for section headings: they now carry exactly one wrapper
           * (`[data-reveal-mask]`, added in SectionHeading), so the real
           * mechanism is available for the largest, most conspicuous text on
           * the page at the cost of one span.
           *
           * Opacity is pinned at 1 throughout — the reference never fades
           * these — so the h2 is legible from first paint even mid-tween,
           * which keeps the "nothing is revealed only by scrolling" rule.
           */
          const masks = all
            .filter((el) => el.tagName === 'H2')
            .map((h2) => h2.querySelector<HTMLElement>('[data-reveal-mask]'))
            .filter((el): el is HTMLElement => el !== null)

          const fading = all.filter(
            (el) => !(el.tagName === 'H2' && el.querySelector('[data-reveal-mask]')),
          )

          for (const mask of masks) {
            const heading = mask.parentElement

            /*
             * The clip is armed HERE, with the from-state — not in `onStart`.
             *
             * `onStart` fires when the tween begins, which is when the heading
             * scrolls into range. Between build and that moment the span is
             * already displaced 110% downward, so an un-clipped heading
             * rendered its own text ~86px below where it belongs, in full
             * view, overlapping whatever sat under it. Measured on the first
             * attempt; arming the clip alongside the offset is what makes the
             * two states consistent.
             */
            if (heading) gsap.set(heading, { overflow: 'clip' })

            gsap.fromTo(
              mask,
              { yPercent: 110 },
              {
                yPercent: 0,
                ease: 'power3.out',
                duration: 0.6,
                scrollTrigger: { trigger: heading ?? mask, start: 'top 85%', once: true },
                /*
                 * Cleared the moment the slide lands: a permanent
                 * `overflow: clip` on a heading crops descenders and any focus
                 * ring a heading link draws.
                 */
                onComplete: () => heading && gsap.set(heading, { clearProps: 'overflow' }),
              },
            )
          }

          if (fading.length === 0) return

          gsap.fromTo(fading, REVEAL_FROM, {
            ...REVEAL_TO,
            stagger: staggerFor(fading.length),
            scrollTrigger: { trigger: section, start: 'top 85%', once: true },
          })
        }

        for (const chapter of CHAPTERS) {
          if (chapter === 'hero' || chapter === 'introduction') continue
          const section = document.querySelector<HTMLElement>(`[data-chapter="${chapter}"]`)
          if (section) reveal(section)
        }

        /*
         * The remaining sections — Impact, Experience, Skills, Education, FAQ.
         *
         * An earlier ruling left these still, on a measurement showing the
         * reference's own later sections carry no pending reveals. The owner
         * overruled it (2026-08-27): every section takes the entrance grammar,
         * so the page reads as one continuous choreography rather than motion
         * that runs out two-thirds of the way down. The values stay the
         * measured reference values — this extends coverage, not vocabulary.
         */
        for (const section of gsap.utils.toArray<HTMLElement>('main section:not([data-chapter])')) {
          reveal(section)
        }
      })
    }

    // Poll rather than observe: the condition is "nothing is loading", which is
    // the absence of an element, and MutationObserver is awkward at spotting
    // absences. Capped so a stuck query cannot mean no choreography at all —
    // but generously: a cold Supabase round-trip has been measured at ~3.3s,
    // and a build that fires mid-load arms elements React is about to replace
    // (see the variant-shape note in ExperienceSection).
    /*
     * BUILD WHEN THE MAIN THREAD IS FREE, never in the paint's way.
     *
     * Building is not cheap: every ScrollTrigger resolves its start/end against
     * live geometry and every `yPercent` tween measures its target, so the pass
     * is a burst of forced synchronous layout. Run inline, it landed on the
     * same frame as the hero portrait's post-hydration paint and pushed LCP
     * from a 2176-2332ms worst case to 2512-2800ms — six of six throttled runs
     * over the 2500ms floor, measured against the same build with this
     * scheduling removed. Nothing about the choreography needs to win that
     * race: every element it touches is below the fold.
     *
     * `requestIdleCallback` yields to painting and input; the timeout is the
     * backstop for a thread that never goes idle, and the setTimeout fallback
     * covers Safari, which still lacks the API.
     */
    const scheduleBuild = () => {
      if (cancelled) return
      const run = () => {
        build()
        // Positions are computed during build; one refresh after layout settles
        // catches any late reflow (web fonts, images) without re-creating tweens.
        window.setTimeout(() => ScrollTrigger.refresh(), 600)
      }
      // `typeof window.requestIdleCallback`, not `'requestIdleCallback' in
      // window`: the `in` form narrows `window` itself and leaves `never` in
      // the else branch. Called as a member so `this` stays the window.
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1500 })
      } else {
        window.setTimeout(run, 200)
      }
    }

    const started = Date.now()
    const waitForContent = window.setInterval(() => {
      const busy = document.querySelectorAll('[aria-busy="true"]').length > 0
      if (busy && Date.now() - started < 8000) return
      window.clearInterval(waitForContent)
      scheduleBuild()
    }, 120)

    const refresh = () => ScrollTrigger.refresh()
    window.addEventListener('load', refresh)

    return () => {
      cancelled = true
      window.clearInterval(waitForContent)
      window.removeEventListener('load', refresh)
      // revert() also restores every inline style GSAP set, so leaving the
      // homepage cannot strand an element at opacity 0.
      context?.revert()
    }
  }, [])

  return null
}

export default ScrollChoreography
