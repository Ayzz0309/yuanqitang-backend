const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';
const CUSTOMER_GROUP_ID = process.env.CUSTOMER_GROUP_ID || '';

// ── 發送 LINE 訊息 ──
async function sendLineMsg(to, text) {
  if (!LINE_TOKEN || !to) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    console.error('LINE 發送失敗:', e.response?.data || e.message);
  }
}

// ── 健康檢查 ──
app.get('/', (req, res) => res.json({ status: 'ok', service: '元氣堂預約系統後端' }));

// ── 客人預約通知 ──
app.post('/api/notify/new-booking', async (req, res) => {
  const { name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

  const staffMsg = `【元氣堂】新預約通知 ${now} 📋
━━━━━━━━━━━━━
客人：${name}
電話：${phone}
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
${note ? '備註：' + note : ''}
━━━━━━━━━━━━━
請登入系統接案 👆`;

  const custMsg = `【元氣堂】預約成功！✅
━━━━━━━━━━━━━
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━
我們會盡快確認，敬請稍候
如需修改請來電：0987-450-468`;

  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, staffMsg),
    sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
  ]);

  res.json({ ok: true });
});

// ── 員工接案通知 ──
app.post('/api/notify/accepted', async (req, res) => {
  const { empId, empName, name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

  const staffMsg = `【元氣堂後台】接案確認 ${now} ✅
━━━━━━━━━━━━━
員工：${empName}（${empId}）已接案
客人：${name} ／ ${phone}
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
━━━━━━━━━━━━━`;

  const custMsg = `【元氣堂】您的預約已確認 🎉
━━━━━━━━━━━━━
療程：${svc} ${dur}
日期：${date} ${time}
費用：NT$${price}
接待師傅：${empName}
━━━━━━━━━━━━━
請準時到場，期待為您服務！
如有疑問：0987-450-468`;

  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, staffMsg),
    sendLineMsg(CUSTOMER_GROUP_ID, custMsg)
  ]);

  res.json({ ok: true });
});

// ── LINE Webhook（拿 Group ID 用）──
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  events.forEach(event => {
    const src = event.source;
    if (src.type === 'group') {
      console.log('GROUP ID:', src.groupId);
    }
    if (src.type === 'room') {
      console.log('ROOM ID:', src.roomId);
    }
  });
});

// ── 查詢 Group ID（給老闆用）──
app.get('/api/check-groups', (req, res) => {
  res.json({
    staffGroupId: STAFF_GROUP_ID || '尚未設定',
    customerGroupId: CUSTOMER_GROUP_ID || '尚未設定',
    tokenSet: !!LINE_TOKEN
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`元氣堂後端啟動 port ${PORT}`));
