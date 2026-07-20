const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const transporter = nodemailer.createTransport({
  host: 'mail.soosan.co.kr',
  port: 25,
  secure: false,
  ignoreTLS: true,
  tls: { rejectUnauthorized: false },
});

// 알림 발송 이력 파일 (하루 1회 중복 방지)
const NOTIFY_LOG = './notify_log.json';
function getNotifyLog() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_LOG, 'utf8')); } catch { return {}; }
}
function saveNotifyLog(log) {
  fs.writeFileSync(NOTIFY_LOG, JSON.stringify(log), 'utf8');
}

// 메일 전송
async function sendMail(to, subject, html) {
  await transporter.sendMail({
    from: '"허창영" <nicehehe@soosan.co.kr>',
    to,
    subject,
    html,
  });
}

// 마감일 체크 및 알림 발송
app.post('/notify-deadlines', async (req, res) => {
  const { cases } = req.body;
  if (!Array.isArray(cases)) return res.status(400).json({ ok: false, error: 'cases 필요' });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const log = getNotifyLog();
  const targets = [];

  for (const c of cases) {
    if (!c.dueDate || c.stages) {
      // 완료 여부 확인
      const stageVals = Object.values(c.stages || {});
      const allDone = stageVals.length && stageVals.every(s => s === 'done' || s === 'na');
      if (allDone) continue;
    }
    if (!c.dueDate) continue;

    const due = new Date(c.dueDate);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

    if (![7, 3, 1].includes(diffDays)) continue;

    // 오늘 이미 보낸 건은 스킵
    const logKey = `${todayStr}_${c.id}_D${diffDays}`;
    if (log[logKey]) continue;

    targets.push({ ...c, diffDays, logKey });
  }

  if (!targets.length) return res.json({ ok: true, sent: 0, msg: '발송할 알림 없음' });

  // 이메일 본문 작성
  const rows = targets.map(c => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:600;">${c.name}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888;">${c.vendor || '-'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;">${c.dueDate}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:${c.diffDays === 1 ? '#F04452' : c.diffDays === 3 ? '#FF9800' : '#3182F6'};font-weight:700;">
        D-${c.diffDays}
      </td>
    </tr>`).join('');

  const html = `
<div style="font-family:'맑은 고딕',sans-serif;max-width:640px;margin:0 auto;">
  <div style="background:#3182F6;padding:24px 28px;border-radius:12px 12px 0 0;">
    <h2 style="color:#fff;margin:0;font-size:18px;">📋 구매계약 납품기한 알림</h2>
    <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px;">${todayStr} 기준</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e8eb;border-top:none;border-radius:0 0 12px 12px;padding:20px 28px;">
    <p style="color:#4e5968;font-size:14px;margin-bottom:16px;">아래 구매 건의 납품기한이 임박했습니다.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
      <thead>
        <tr style="background:#f2f4f6;">
          <th style="padding:10px 14px;text-align:left;font-weight:700;">건명</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;">업체</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;">납품기한</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;">D-day</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#8b95a1;font-size:12px;margin-top:20px;">수산이앤에스 경영지원팀 구매관리시스템 자동 발송</p>
  </div>
</div>`;

  try {
    await sendMail('nicehehe@soosan.co.kr', `[구매알림] 납품기한 임박 ${targets.length}건 (${todayStr})`, html);

    // 발송 이력 저장
    const newLog = getNotifyLog();
    targets.forEach(c => { newLog[c.logKey] = todayStr; });
    // 오래된 로그 정리 (30일 이상)
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    Object.keys(newLog).forEach(k => { if (k.slice(0, 10) < cutoffStr) delete newLog[k]; });
    saveNotifyLog(newLog);

    res.json({ ok: true, sent: targets.length, items: targets.map(c => `${c.name} D-${c.diffDays}`) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/send', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject) return res.status(400).json({ ok: false, error: '수신자와 제목은 필수입니다.' });
  try {
    await transporter.sendMail({
      from: '"허창영" <nicehehe@soosan.co.kr>',
      to,
      subject,
      text: body || '',
      html: (body || '').replace(/\n/g, '<br>'),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, msg: '메일 서버 실행 중' }));

const PORT = 3000;
// 127.0.0.1 로만 바인딩 → 같은 PC(로컬)에서만 접근 가능. LAN 다른 기기의 무단 메일 릴레이 차단.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`메일 서버 실행 중: http://127.0.0.1:${PORT} (로컬 전용)`);
  console.log(`SMTP: mail.soosan.co.kr:25`);
});
