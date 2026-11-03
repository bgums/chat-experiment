// Isolated UI fixture: no production database or model calls.
import express from "express";
import path from "node:path";
const app = express();
app.use(express.static(path.resolve("client")));
app.get("/preview", (_req, res) => res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>תצוגת אימון מכוון</title></head>
<body><main class="app-shell"><div id="preview" class="step-container"></div></main>
<script type="module">
import { renderPractice } from '/practice.js';
const config = { maxAttemptsPerStrategy: 3, strategiesPerChat: 1, maxMessageLength: 6000, showScoresToParticipant: true };
const originalMessages = [
  {id:1,role:'assistant',content:'קשה לי לשתף אנשים במה שעובר עליי.'},
  {id:2,role:'user',content:'מה קורה כשאתה מנסה לדבר על זה?'},
  {id:3,role:'assistant',content:'אני חושש שכולם יציעו פתרונות.'},
  {id:4,role:'user',content:'אולי כדאי שתנסה לדבר איתה ישירות.'},
  {id:5,role:'assistant',content:'אתה מיד מציע לי פתרונות, אבל אני מרגיש שאתה בכלל לא מבין כמה זה קשה לי.'},
  {id:6,role:'user',content:'אולי תוכל להסביר לה מה אתה צריך.'}
];
let rounds = [];
const fetchApi = async (url, options) => {
  if (url.endsWith('/start')) rounds.push({id: rounds.length + 1, round_number: rounds.length + 1, config, attempts: [], status: 'active', plan: {
    title: rounds.length ? 'בירור הקרע בקשר' : 'תיקוף החוויה הרגשית', explanation: 'נחזור לרגע שבו המטופל הרגיש שלא הובן, וננסה לתת מקום לחוויה שלו.',
    principles: 'הקשבה, הכרה ברגש וסקרנות כלפי החוויה של המטופל.', application: 'תארו בזהירות את מה ששמעתם והזמינו את המטופל לתקן את הבנתכם.',
    hint: 'נסו לתת מקום לתחושה שלא הובן, לפני שאתם מציעים פתרון.', excerpt: originalMessages.slice(-3)
  }});
  if (url.endsWith('/attempt')) {
    const body = JSON.parse(options.body); const round = rounds.at(-1);
    round.attempts.push({therapist_message:body.message, patient_message:'כן, אני צריך קודם להרגיש שיש כאן מקום למה שאני עובר.', feedback:'נתת מקום לחוויה שלי בלי למהר לפתרון. אפשר להמשיך ולברר כיצד התגובה הקודמת שלך השפיעה על הקשר.', summary:'ניסית לעבור מפתרון בעיות להכרה בחוויה של המטופל.', score:3});
    round.status = round.attempts.length >= config.maxAttemptsPerStrategy ? 'attempt_limit' : 'active';
  }
  return {ok:true, json:async()=>structuredClone({config, rounds, originalMessages})};
};
renderPractice({step:{token:'fixture',sessionPersonaId:1,persona:{name:'מטופל לדוגמה'}},container:document.getElementById('preview'),fetchApi,readOnly:false,isCurrent:()=>true,next:()=>document.getElementById('preview').textContent='התרגול הושלם'});
</script></body></html>`));
app.listen(3117, "127.0.0.1", () => console.log("Practice UI fixture: http://127.0.0.1:3117/preview"));
