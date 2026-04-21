const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';
const CUSTOMER_GROUP_ID = process.env.CUSTOMER_GROUP_ID || '';

async function sendLineMsg(to, text) {
  if (!LINE_TOKEN || !to) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to, messages: [{ type: 'text', text }]
    }, { headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) { console.error('LINE失敗:', e.response?.data || e.message); }
}

app.get('/', (req, res) => res.json({ status: 'ok', service: '元氣堂後端' }));

app.post('/api/notify/new-booking', async (req, res) => {
  const { name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, `【元氣堂】新預約 ${now} 📋\n━━━━━━━━━━━\n客人：${name}\n電話：${phone}\n療程：${svc} ${dur}\n日期：${date} ${time}\n費用：NT$${price}${note ? '\n備註：' + note : ''}\n━━━━━━━━━━━\n請登入系統接案 👆`),
    sendLineMsg(CUSTOMER_GROUP_ID, `【元氣堂】新預約通知 ${now}\n━━━━━━━━━━━\n療程：${svc} ${dur}\n日期：${date} ${time}\n費用：NT$${price}\n━━━━━━━━━━━\n等待員工確認中...`)
  ]);
  res.json({ ok: true });
});

app.post('/api/notify/accepted', async (req, res) => {
  const { empId, empName, name, phone, svc, dur, date, time, price, note } = req.body;
  const now = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  await Promise.all([
    sendLineMsg(STAFF_GROUP_ID, `【元氣堂後台】接案確認 ${now} ✅\n━━━━━━━━━━━\n員工：${empName}（${empId}）\n客人：${name} ／ ${phone}\n療程：${svc} ${dur}\n日期：${date} ${time}\n費用：NT$${price}\n━━━━━━━━━━━`),
    sendLineMsg(CUSTOMER_GROUP_ID, `【元氣堂】預約已確認 🎉\n━━━━━━━━━━━\n療程：${svc} ${dur}\n日期：${date} ${time}\n費用：NT$${price}\n接待師傅：${empName}\n━━━━━━━━━━━\n請準時到場！0987-450-468`)
  ]);
  res.json({ ok: true });
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  (req.body.events || []).forEach(e => {
    if (e.source.type === 'group') console.log('GROUP ID:', e.source.groupId);
  });
});

app.get('/api/check-groups', (req, res) => res.json({
  staffGroupId: STAFF_GROUP_ID || '未設定',
  customerGroupId: CUSTOMER_GROUP_ID || '未設定',
  tokenSet: !!LINE_TOKEN
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`元氣堂後端啟動 port ${PORT}`));
