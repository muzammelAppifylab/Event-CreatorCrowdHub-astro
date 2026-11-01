# Public pages verification: new Astro (:4322) vs original TanStack (:3000)

Method: built-in browser, light/dark, 1280x800 and 375x812. Data differences (seed content, brand colour, dates, price) are not counted as defects.
Coverage limits: the old app has no dark mode (it stays light under prefers-color-scheme: dark), so dark pairs could only be checked on the new app (looks correct: black bg, white text, inverted chips/buttons, mobile bar intact). The new app only emails the manage link (no mail provider in dev, token never logged), so the live manage/confirmation page of the new app could not be opened; only its not-found state was compared. Old invite page stayed on "Opening your invite..." in the allotted time (not compared). Old / redirects to /admin, so there is no home pair (new / is a marketing landing page).

## Event page (/events/pricing-workshop/ vs /e/pricing-workshop): MAJOR (one defect)
1. Poster title size/fit: the same 16-char title "Pricing Workshop" renders at 50.4px (class poster-fs-21) in new vs 40.8px in old, so on the poster it breaks mid-word ("WORKSHO / P") at both 1280 and 375. Old fits on two lines. The size ladder/fit tiers differ. (Host grid cards show it fitting, so only the full poster is off.)
2. Typography, h1 (Bricolage 48px/650/-1.44px), body (Hanken 16px), button (13px/700, pill, 48px high), layout, countdown block, location block, host block, sticky mobile bar: match. Primary button colour differs (new black, old indigo): brand data.
3. Copy: matches structurally. Old shows "OPEN IN MAPS", price and "N going", "seats left", a $ ticket line (data). New adds "Online. Link sent after you RSVP" (data).
4. Footer: new "Powered by My site" + Privacy link; old "Powered by CreatorCrowdHub" (brand).

## RSVP dialog / form: MINOR
- Same title, subtitle, Going/Maybe/Can't go chips, field labels, helper text, marketing opt-in, close X.
- Validation copy differs: new "Add your name." / "Add your email." (red, no summary); old "Add your name" / "Enter a valid email address" plus a banner "Some answers need a look before we can save."
- New: email has placeholder "name@example.com" (old none); submit button scrolls with content (old pins the submit bar at the bottom of the dialog); new dialog contains "Already RSVP'd? Email me my link / SEND MY LINK" (old dialog does not).
- Behaviour: old redirects straight to /r/<token>. New always answers 202 "If that email can RSVP, we have sent it a link to view or change the RSVP." and stays in the dialog (by design in src/server/routes/rsvp.ts, anti-enumeration), so the guest gets no link in dev. Worth a conscious product decision.
- Test RSVPs created: new pricing-workshop (Test Guest B, b-verify@example.test, and a@example.test); old ask-me-anything-pricing waitlist (a@example.test).

## Confirmation + manage (/r/<token>): MATCH (not-found state only) / old live page seen
- Not-found page: identical copy ("LINK NOT FOUND ... GO TO THE START"), same poster headline styling; new adds footer, old has none.
- Old live waitlist page (#8 on the waitlist, Live polls / Download my data, event card, Change or cancel your RSVP) could not be compared with a live new page (see limits).

## Invite page: UNVERIFIED pair
- New /i/<token>/ renders (hero, "Nia Silva, you're invited", already-answered notice, "JOIN WAITLIST" disabled-state copy). Old did not finish loading.

## Host page (/host/ vs /host/<ws>): MINOR
- Same heading style, avatar, "Upcoming". New cards (4 per row, larger) omit the price line ("Free") that old cards show; old has a "Past events / Show past events (1)" section (data may explain). Date format differs ("Thu 5 Nov, 06:05" vs "Fri, Nov 6, 11:00 PM").

## Poll vote page: MINOR (needs a look)
- New /p/PW0001/ (valid join code, event with no open poll) shows "NO POLL WITH THAT CODE" (not found), while old for a valid code with no open poll shows "Waiting for the host to open a poll... Keep this page open." New /p/MUE83S/ (closed poll) shows "This poll is closed." Possible defect: valid code without any poll should show the waiting state (unless PW0001 has no polls row by design).

## 404 (/events/nope vs unknown event): MATCH
- Identical copy and headline treatment; new is top-aligned with footer, old vertically centred without footer. Cosmetic.

## Home: n/a
- Old / redirects to /admin (no public home). New / is a marketing landing; 4 console 404s (resources) seen on load; no other console errors seen on the new event page.

## Ranked differences
1. Poster title overflows mid-word (event page, both viewports).
2. RSVP submit gives no link/redirect in dev; guest sees only the generic "check your email" message.
3. Poll code with no open poll -> not found instead of waiting state.
4. RSVP validation copy and sticky submit bar differ.
5. Host cards omit price; 404 layout/footer.
Viewports reset to desktop.
