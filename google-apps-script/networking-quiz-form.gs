/**
 * מבחן מסכם: מושגי יסוד ברשתות תקשורת
 *
 * הוראות הרצה:
 * 1. היכנסו אל https://script.google.com ולחצו "פרויקט חדש".
 * 2. הדביקו את כל הקוד הזה במקום התוכן הקיים ושמרו (Ctrl+S).
 * 3. בחרו בפונקציה createNetworkingQuiz בסרגל העליון ולחצו "הפעלה" (Run).
 * 4. אשרו את בקשת ההרשאות של גוגל (Advanced -> Go to project).
 * 5. פתחו את היומן (View -> Logs / Execution log) — שם יופיעו קישורי העריכה והמענה של הטופס.
 */
function createNetworkingQuiz() {
  // 1. יצירת טופס חדש והגדרתו כמבחן (Quiz)
  var form = FormApp.create('מבחן מסכם: מושגי יסוד ברשתות תקשורת');
  form.setIsQuiz(true);
  form.setDescription('מבחן אמריקאי לבדיקת הבנת מושגי היסוד ברשתות על פי חומרי הלימוד.');

  // הגדרות כלליות למבחן - איסוף אימייל ושחרור ציונים ידני/אוטומטי לפי העדפה
  form.setCollectEmail(true);

  // --- שאלה 1: מתוך קטגוריית "מכשירי רשת" (Switch vs Router) ---
  var q1 = form.addMultipleChoiceItem();
  q1.setTitle('איזה מכשיר מקשר בין מכשירים בתוך רשת מקומית ומעביר מידע על פי כתובות MAC?')
    .setPoints(20)
    .setRequired(true);

  var q1Feedback = FormApp.createFeedback()
    .setText('נכון מאוד! Switch (מתג) מחבר מכשירים בתוך רשת מקומית ומנתב את המידע לפי כתובות MAC, בעוד ש-Router מחבר בין רשתות שונות לפי כתובות IP.')
    .build();

  q1.setChoices([
    q1.createChoice('Router (נתב)', false),
    q1.createChoice('Switch (מתג)', true),
    q1.createChoice('Hub (רכזת)', false),
    q1.createChoice('Modem (מודם)', false)
  ]);
  q1.setFeedbackForCorrect(q1Feedback);
  q1.setFeedbackForIncorrect(q1Feedback);

  // --- שאלה 2: מתוך קטגוריית "חלוקת כתובות" (DHCP vs APIPA) ---
  var q2 = form.addMultipleChoiceItem();
  q2.setTitle('מה תפקידו של פרוטוקול DHCP ברשת?')
    .setPoints(20)
    .setRequired(true);

  var q2Feedback = FormApp.createFeedback()
    .setText('מדויק. DHCP הוא פרוטוקול להקצאת כתובות אוטומטית, המעניק כתובת IP דינמית למכשירים המתחברים לרשת.')
    .build();

  q2.setChoices([
    q2.createChoice('לתרגם שמות מתחם (דומיינים) לכתובות IP', false),
    q2.createChoice('להקצות כתובות IP באופן אוטומטי למכשירים ברשת', true),
    q2.createChoice('לאבטח את תעבורת הרשת מפני פריצות', false),
    q2.createChoice('לקבוע לאיזו תוכנה במחשב להעביר את המידע', false)
  ]);
  q2.setFeedbackForCorrect(q2Feedback);
  q2.setFeedbackForIncorrect(q2Feedback);

  // --- שאלה 3: מתוך קטגוריית "תקשורת והעברת מידע" (TCP vs UDP) ---
  var q3 = form.addMultipleChoiceItem();
  q3.setTitle('איזה פרוטוקול העברה דואג שהמידע יגיע ליעדו בצורה שלמה ובסדר הנכון (Connection-oriented)?')
    .setPoints(20)
    .setRequired(true);

  var q3Feedback = FormApp.createFeedback()
    .setText('נכון! פרוטוקול TCP מבטיח הגעה אמינה ושלמה של המידע באמצעות מנגנונים כמו 3-Way Handshake ואישורי הגעה (ACK), בניגוד ל-UDP ששולח מידע מהר וללא בדיקת הגעה.')
    .build();

  q3.setChoices([
    q3.createChoice('UDP (User Datagram Protocol)', false),
    q3.createChoice('ARP (Address Resolution Protocol)', false),
    q3.createChoice('TCP (Transmission Control Protocol)', true),
    q3.createChoice('DNS (Domain Name System)', false)
  ]);
  q3.setFeedbackForCorrect(q3Feedback);
  q3.setFeedbackForIncorrect(q3Feedback);

  // --- שאלה 4: מתוך קטגוריית "מציאת מכשירים ברשת" (ARP) ---
  var q4 = form.addMultipleChoiceItem();
  q4.setTitle('כאשר מחשב יודע את כתובת ה-IP של היעד אך זקוק לכתובת ה-MAC הפיזית שלו, באיזה פרוטוקול הוא ישתמש?')
    .setPoints(20)
    .setRequired(true);

  var q4Feedback = FormApp.createFeedback()
    .setText('תשובה נכונה. פרוטוקול ARP (Address Resolution Protocol) משמש לגילוי כתובת ה-MAC על פי כתובת ה-IP הידועה ברשת המקומית.')
    .build();

  q4.setChoices([
    q4.createChoice('DNS', false),
    q4.createChoice('ARP', true),
    q4.createChoice('DHCP', false),
    q4.createChoice('APIPA', false)
  ]);
  q4.setFeedbackForCorrect(q4Feedback);
  q4.setFeedbackForIncorrect(q4Feedback);

  // --- שאלה 5: מתוך קטגוריית "מודלים" (OSI Model) ---
  var q5 = form.addMultipleChoiceItem();
  q5.setTitle('מכמה שכבות מורכב מודל OSI (Open Systems Interconnection) המיועד לייצוג פרוטוקולי תקשורת?')
    .setPoints(20)
    .setRequired(true);

  var q5Feedback = FormApp.createFeedback()
    .setText('מעולה! מודל OSI הוא מודל תיאורטי המחלק את תקשורת הרשת ל-7 שכבות פונקציונליות שונות.')
    .build();

  q5.setChoices([
    q5.createChoice('4 שכבות', false),
    q5.createChoice('5 שכבות', false),
    q5.createChoice('7 שכבות', true),
    q5.createChoice('3 שכבות', false)
  ]);
  q5.setFeedbackForCorrect(q5Feedback);
  q5.setFeedbackForIncorrect(q5Feedback);

  // הדפסת קישור לעריכה וצפייה בלוג של Apps Script
  Logger.log('המבחן נוצר בהצלחה!');
  Logger.log('קישור לעריכת הטופס: ' + form.getEditUrl());
  Logger.log('קישור למענה על הטופס: ' + form.getPublishedUrl());
}
