# מי פה? 👀 — אפקט TikTok (Effect House)

משחק הצבעה חברתי: שאלה → 3, 2, 1 → **👉 עכשיו!** → כולם מצביעים → נגיעה לשאלה הבאה.

```
פתיחה (1.5 שנ׳)  →  שאלה (כרטיס זכוכית)  →  3 · 2 · 1  →  👉 עכשיו! + פיצוץ אימוג׳י  →  "נגיעה למסך לשאלה הבאה"
   INTRO               QUESTION               COUNTDOWN        REVEAL                         WAITING_FOR_NEXT
```

## מה יש בתיקייה

| נתיב | תפקיד |
|---|---|
| `Scripts/GameManager.ts` | **הסקריפט שמחברים באפקט.** רכיב APJS שמעביר זמן ונגיעות ל-GameFlow ומחיל את התוצאה על הסצנה |
| `Scripts/GameFlow.ts` | מכונת המצבים וכל האנימציות (INTRO → QUESTION → COUNTDOWN → REVEAL → WAITING_FOR_NEXT) |
| `Scripts/SceneNode.ts` | מתאם ל-APJS: שקיפות, גודל, מיקום, סיבוב, טקסט, צבע וסאונד, עם זיהוי אוטומטי של שמות המאפיינים |
| `Scripts/QuestionPicker.ts` | בחירה אקראית עם היסטוריה של 5 השאלות האחרונות (אין חזרה ברצף) |
| `Scripts/Questions.ts` | 95 שאלות |
| `Scripts/TextLayout.ts` | שבירת שורות מאוזנת (עד 3 שורות) + תיקון RTL למקרה שהמנוע מציג עברית הפוכה |
| `Scripts/GameConfig.ts` | תזמונים, מיקומים, טקסטים וצבעים, הכול במקום אחד |
| `Scripts/Easing.ts` | פונקציות easing |
| `Assets/Textures/` | `BackgroundOverlay.png`, `QuestionCard.png` (זכוכית), `CardGlow.png`, `RadialGlow.png`, `Flash.png`: בסך הכול כ-135KB |
| `Assets/Fonts/` | Heebo Black / Medium (רישיון OFL, תומך בעברית) |
| `Assets/Audio/` | `sfx_tick.wav`, `sfx_now.wav`, `sfx_whoosh.wav`: קצרים ועדינים, סונתזו במיוחד לאפקט (בלי זכויות צד ג׳) |
| `preview/index.html` | תצוגה מקדימה בדפדפן שמריצה את **אותו קוד בדיוק** (מצלמה או רקע דמו, והצגת אזורי ה-UI של טיקטוק) |
| `tests/` | בדיקות יחידה: אקראיות, חזרות, לחיצות מהירות, ספירה לאחור, שבירת שורות ו-RTL |

## הקמה ב-Effect House (כ-15 דקות)

> אין לי גישה לאפליקציית Effect House עצמה (היא אפליקציית דסקטופ), ולכן את הסצנה צריך להרכיב ידנית לפי המדריך הזה. כל הלוגיקה והאנימציות נמצאות בקוד, ובעורך רק ממקמים אובייקטים ומחברים אותם.

### 1. ייבוא נכסים
גררו לפאנל **Assets** את כל תיקיית `Assets/`.

**הסקריפט (קובץ אחד):** ב-Assets לחצו **+ → Script → New Script Component**, שנו את השם ל-`GameManager`, לחצו **Open in external editor**, מחקו את כל התוכן והדביקו במקומו את כל התוכן של `dist/GameManager.ts`. הקובץ הזה מאחד את כל הקבצים שב-`Scripts/`, כך שלא צריך לייבא אותם בנפרד. אחרי שינוי ב-`Scripts/` מריצים `npm run build:single` כדי לבנות אותו מחדש.

### 2. היררכיה
צרו פרויקט חדש (Front camera). מתחת ל-**2D / Screen** צרו את האובייקטים הבאים **בסדר הזה**. הסדר קובע את סדר השכבות: מה שמופיע למטה ברשימה מצויר מעל.

מיקומים (מרכז האובייקט) לפי מסגרת של 1080×1920. אם הקנבס בפרויקט הוא 720×1280, הכפילו כל ערך ב-0.667.

| # | שם האובייקט | סוג | הגדרות | מרכז (x, y מלמעלה) | גודל |
|---|---|---|---|---|---|
| 1 | `BackgroundOverlay` | Image | Texture: `BackgroundOverlay.png`, מתיחה למסך מלא | מסך מלא | 1080×1920 |
| 2 | `Flash` | Image | `Flash.png`, לבן | מסך מלא | 1080×1920 |
| 3 | `IntroTitle` | Text | Heebo-Black, ‏150, לבן, מרכוז, Shadow עדין | 540, 800 | – |
| 4 | `IntroSubtitle` | Text | Heebo-Medium, ‏62, לבן | 540, 940 | – |
| 5 | `CardGlow` | Image | `CardGlow.png`, Blend: Add/Screen | 540, 520 | 1012×572 |
| 6 | `QuestionCard` | Image | `QuestionCard.png` | 540, 520 | 916×476 |
| 6.1 | ↳ `QuestionText` (ילד של QuestionCard) | Text | Heebo-Black, ‏92, לבן, מרכוז, Line spacing ‏1.1, Shadow/Outline עדין | 0, 0 (יחסית לכרטיס) | רוחב 760 |
| 7 | `QuestionEmoji` | Text | פונט ברירת מחדל (למען האימוג׳י), ‏124 | 540, 330 | – |
| 8 | `CountdownGlow` | Image | `RadialGlow.png`, Blend: Add | 540, 1230 | 760×760 |
| 9 | `CountdownText` | Text | Heebo-Black, ‏400, Outline לבן 8–10 | 540, 1230 | – |
| 10 | `FXContainer` | Empty (2D) | ההורה של החלקיקים, **מתחת** ל-NowText ברשימה | 540, 1230 | – |
| 10.1–10.10 | ↳ `BurstEmoji_1` … `BurstEmoji_10` | Text | פונט ברירת מחדל, ‏92 | 0, 0 | – |
| 11 | `NowText` | Text | Heebo-Black, ‏168, לבן, Glow/Shadow | 540, 1230 | – |
| 12 | `TapHint` | Text | Heebo-Medium, ‏46, לבן | 540, 1430 | – |
| 13 | `Branding` | Text | Heebo-Medium, ‏28, לבן | 540, 1515 | – |
| 14 | `GameManager` | Empty | + Script component: **GameManager** | – | – |
| 15 | `SfxWhoosh`, `SfxTick`, `SfxNow` | Audio | הקבצים מ-`Assets/Audio`, **Play on start: כבוי**, Loop: כבוי | – | – |

חשוב:
* `CardGlow` ו-`QuestionEmoji` הם **אחים** של `QuestionCard`, לא ילדים שלו. הקוד מזיז אותם יחד עם הכרטיס, וכילדים הם היו זזים פעמיים.
* את הטקסטים לא צריך להקליד. הסקריפט כותב את כולם בזמן ריצה.
* יישור הטקסט בכל ה-Text: **Center / Middle**.

### 3. חיבור ה-GameManager
באינספקטור של GameManager גררו כל אובייקט לשדה שלו:
`backgroundOverlay, introTitle, introSubtitle, questionCard, cardGlow, questionText, questionEmoji, countdownText, countdownGlow, nowText, flash, burstParticles (10 הפריטים), tapHint, branding, sfxWhoosh, sfxTick, sfxNow`.

כל שדה אופציונלי: אובייקט שלא חובר פשוט לא יונפש (בלי שגיאות). לכן אפשר להתחיל רק עם `questionCard` + `questionText` + `countdownText` ולהוסיף את השאר בהדרגה.

הגדרות:
| שדה | ברירת מחדל | מתי לשנות |
|---|---|---|
| `hebrewVisualOrder` | כבוי | **רק אם** ב-Preview העברית מופיעה הפוכה (סדר מילים/אותיות מראה). מדליקים ובודקים שוב |
| `motionScale` | 1 | אם תנועות ה"ציפה" והמעברים נראות גדולות או קטנות מדי. ב-720×1280 נסו 0.667 |
| `soundEnabled` | פועל | כיבוי כל ה-SFX |
| `brandingLabel` | `Created by AiSolution` | אפשר לקצר ל-`AiSolution` |

### 4. בדיקה ב-Preview של Effect House
- [ ] אין שגיאות ב-Console (אם `@component`/`@serializeProperty` לא מוכרים, השוו לתבנית של סקריפט חדש בגרסה שלכם והעתיקו את שורת ה-import שבראשה)
- [ ] עברית תקינה, לא הפוכה. אם הפוכה: `hebrewVisualOrder = true`
- [ ] האימוג׳י לא מוצגים כריבועים. אם כן: באובייקטים עם אימוג׳י בחרו את פונט המערכת/ברירת המחדל
- [ ] הפתיחה נמשכת כ-1.5 שנ׳, אחריה שאלה, 3‑2‑1 ו"עכשיו!"
- [ ] לחיצות מהירות בזמן אנימציה לא עושות כלום, ולחיצה אחת במצב המתנה מתחילה סבב אחד בלבד
- [ ] אין אותה שאלה פעמיים ברצף
- [ ] הכרטיס לא מסתיר פנים (במצלמה קדמית בגובה עיניים)

## תצוגה מקדימה בדפדפן (ללא Effect House)

```bash
cd tiktok-effects/mi-po
npm install
npm run check          # typecheck + בדיקות יחידה + בניית preview/app.js
npx serve .            # ואז לפתוח /preview/index.html
npm run check:preview  # בדיקה אוטומטית ב-Chromium: צילומי מסך של כל שלב, הצפת לחיצות, 100 סבבים, Console
```
כפתורים בתצוגה: 📷 מצלמה · 📐 אזורי UI של טיקטוק · 🔊 סאונד. פרמטרים: `?safe=1`, `?camera=1`, `?mute=1`.

## התאמות מהירות
* **שאלות:** `Scripts/Questions.ts`, כל שורה בפורמט `['טקסט', 'אימוג׳י']`.
* **קצב:** `TIMING` ב-`GameConfig.ts` (למשל `countdownStep: 760` לכל ספרה).
* **טקסטים קבועים:** `COPY` ב-`GameConfig.ts`.
* **צבעי 3/2/1:** `COUNTDOWN_COLORS`.
