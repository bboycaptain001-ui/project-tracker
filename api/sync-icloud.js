const SUPABASE_URL = 'https://rstaitavlvzlinehniaw.supabase.co';

function unfoldLines(ics) {
  return ics.replace(/\r\n/g, '\n').split('\n').reduce((lines, line) => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
    return lines;
  }, []);
}

function unescapeICS(s) {
  return s.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseICS(ics) {
  const lines = unfoldLines(ics);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = rawKey.split(';')[0];
    if (key === 'UID') cur.uid = value;
    else if (key === 'SUMMARY') cur.summary = unescapeICS(value);
    else if (key === 'DESCRIPTION') cur.description = unescapeICS(value);
    else if (key === 'DTSTART') { cur.dtstart = value; cur.dtstartRawKey = rawKey; }
  }
  return events;
}

// 只處理單次事件的 UTC / 浮動時間 / 全天，重複事件（RRULE）先略過，只會拿到第一次發生
function parseDTStart(rawKey, value) {
  const isAllDay = rawKey.includes('VALUE=DATE') && !value.includes('T');
  const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
  if (isAllDay) return { date: `${y}-${m}-${d}`, time: '' };

  const hh = value.slice(9, 11), mm = value.slice(11, 13);
  if (value.endsWith('Z')) {
    const utc = new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm));
    const taipei = new Date(utc.getTime() + 8 * 3600 * 1000);
    const ty = taipei.getUTCFullYear();
    const tm = String(taipei.getUTCMonth() + 1).padStart(2, '0');
    const td = String(taipei.getUTCDate()).padStart(2, '0');
    const th = String(taipei.getUTCHours()).padStart(2, '0');
    const tmin = String(taipei.getUTCMinutes()).padStart(2, '0');
    return { date: `${ty}-${tm}-${td}`, time: `${th}:${tmin}` };
  }
  // 浮動時間或帶 TZID：假設裝置本身就是台北時區，直接當地時間使用
  return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const icsUrl = process.env.ICLOUD_CAL_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!icsUrl) return res.status(500).json({ error: 'ICLOUD_CAL_URL 尚未設定' });
  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY 尚未設定' });

  try {
    const icsRes = await fetch(icsUrl.replace(/^webcal:\/\//, 'https://'));
    if (!icsRes.ok) return res.status(502).json({ error: '讀取 iCloud 行事曆失敗', status: icsRes.status });
    const icsText = await icsRes.text();

    const windowStart = new Date(Date.now() - 7 * 86400000);
    const rows = parseICS(icsText)
      .filter(e => e.uid && e.summary && e.dtstart)
      .map(e => {
        const { date, time } = parseDTStart(e.dtstartRawKey, e.dtstart);
        return {
          id: `icloud-${e.uid}`,
          title: e.summary,
          date,
          time: time || null,
          type: 'task',
          project_id: null,
          note: e.description || '',
          updated_at: new Date().toISOString(),
        };
      })
      .filter(r => r.date && new Date(r.date) >= windowStart);

    if (rows.length === 0) return res.status(200).json({ synced: 0 });

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/events?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });

    if (!upsertRes.ok) {
      return res.status(502).json({ error: 'Supabase 寫入失敗', detail: await upsertRes.text() });
    }

    return res.status(200).json({ synced: rows.length });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
