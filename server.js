/**
 * ⚡ WANZZ INSTALLER — Backend Server
 * Node.js + Express + SSH2
 *
 * CARA INSTALL & JALANKAN:
 *   npm install express ssh2 cors
 *   node server.js
 *
 * Server berjalan di: http://localhost:3000
 */

const express = require('express');
const { Client } = require('ssh2');
const cors = require('cors');
const http = require('http');
const { EventEmitter } = require('events');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve wanzz-installer.html

// Simpan SSE clients per jobId
const jobs = {};

// ─────────────────────────────────────────
// SSE helper — kirim event ke browser
// ─────────────────────────────────────────
function sendEvent(jobId, type, data) {
  const clients = jobs[jobId]?.clients || [];
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  clients.forEach(res => res.write(payload));
}

// ─────────────────────────────────────────
// GET /events/:jobId  — SSE stream
// ─────────────────────────────────────────
app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!jobs[jobId]) jobs[jobId] = { clients: [] };
  jobs[jobId].clients.push(res);

  req.on('close', () => {
    jobs[jobId].clients = jobs[jobId].clients.filter(c => c !== res);
  });
});

// ─────────────────────────────────────────
// Fungsi SSH exec dengan auto-answer prompt
// ─────────────────────────────────────────
function sshExec(conn, command, jobId, promptHandlers, onClose) {
  conn.exec(command, { pty: true }, (err, stream) => {
    if (err) {
      sendEvent(jobId, 'log', { msg: `SSH exec error: ${err.message}`, type: 'error' });
      if (onClose) onClose(1);
      return;
    }

    let buffer = '';

    stream.on('data', (data) => {
      const str = data.toString();
      buffer += str;

      // Kirim output ke browser
      str.split('\n').forEach(line => {
        const clean = line.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim();
        if (clean) sendEvent(jobId, 'log', { msg: clean, type: '' });
      });

      // Cek prompt dan jawab otomatis
      for (const [trigger, answer] of promptHandlers) {
        if (buffer.includes(trigger)) {
          stream.write(answer + '\n');
          buffer = buffer.replace(trigger, ''); // hindari double trigger
        }
      }
    });

    stream.stderr.on('data', (data) => {
      const str = data.toString().trim();
      if (str) sendEvent(jobId, 'log', { msg: str, type: 'warn' });
    });

    stream.on('close', (code) => {
      if (onClose) onClose(code);
    });
  });
}

// ─────────────────────────────────────────
// POST /install  — Install Panel + Wings
// ─────────────────────────────────────────
app.post('/install', (req, res) => {
  const { ip, password, domainPanel, domainNode, ram, panelPass } = req.body;

  if (!ip || !password || !domainPanel || !domainNode || !ram) {
    return res.status(400).json({ error: 'Field tidak lengkap' });
  }

  const jobId = Date.now().toString();
  jobs[jobId] = { clients: [] };
  res.json({ jobId });

  // Mulai proses SSH secara async
  setTimeout(() => runInstall(jobId, { ip, password, domainPanel, domainNode, ram, panelPass: panelPass || 'admin001' }), 200);
});

async function runInstall(jobId, { ip, password, domainPanel, domainNode, ram, panelPass }) {
  const conn = new Client();

  const connSettings = {
    host: ip,
    port: 22,
    username: 'root',
    password: password,
    readyTimeout: 20000,
  };

  sendEvent(jobId, 'log', { msg: `Menghubungkan ke ${ip}:22...`, type: 'info' });
  sendEvent(jobId, 'progress', { pct: 2 });

  conn.on('ready', () => {
    sendEvent(jobId, 'log', { msg: `✅ Koneksi SSH berhasil ke root@${ip}`, type: 'success' });
    sendEvent(jobId, 'progress', { pct: 5 });

    // ── Step 1: Install Panel ──
    sendEvent(jobId, 'log', { msg: `Memulai instalasi Pterodactyl Panel...`, type: 'info' });
    sendEvent(jobId, 'progress', { pct: 8 });

    const panelPrompts = [
      ['Input 0-6',                                         '0'],
      ['(y/N)',                                             'y'],
      ['Database name (panel)',                             ''],
      ['Database username (pterodactyl)',                   'admin'],
      ['Password (press enter to use randomly generated',   'admin'],
      ['Select timezone [Europe/Stockholm]',                'Asia/Jakarta'],
      ["Provide the email address that will be used",       'admin@gmail.com'],
      ['Email address for the initial admin account',       'admin@gmail.com'],
      ['Username for the initial admin account',            'admin'],
      ['First name for the initial admin account',          'admin'],
      ['Last name for the initial admin account',           'admin'],
      ['Password for the initial admin account',            panelPass],
      ['Set the FQDN of this panel',                        domainPanel],
      ['Do you want to automatically configure UFW',        'y'],
      ["Do you want to automatically configure HTTPS",      'y'],
      ["Select the appropriate number [1-2]",               '1'],
      ["I agree that this HTTPS request is performed",      'y'],
      ['Proceed anyways',                                   'y'],
      ['(yes/no)',                                          'yes'],
      ['Initial configuration completed. Continue',         'y'],
      ['Still assume SSL',                                  'y'],
      ['Please read the Terms of Service',                  'y'],
      ['(A)gree/(C)ancel:',                                 'A'],
    ];

    sshExec(conn, 'bash <(curl -s https://pterodactyl-installer.se)', jobId, panelPrompts, (code) => {
      sendEvent(jobId, 'progress', { pct: 55 });
      sendEvent(jobId, 'log', { msg: `✅ Instalasi Panel selesai!`, type: 'success' });

      // ── Step 2: Install Wings ──
      sendEvent(jobId, 'log', { msg: `Memulai instalasi Wings...`, type: 'info' });
      sendEvent(jobId, 'progress', { pct: 60 });

      const wingsPrompts = [
        ['Input 0-6',                                           '1'],
        ['(y/N)',                                               'y'],
        ['Enter the panel address',                             domainPanel],
        ['Database host username',                              'admin'],
        ['Database host password',                              'admin'],
        ["Set the FQDN to use for Let's Encrypt",               domainNode],
        ['Enter email address for Let\'s Encrypt',              'admin@gmail.com'],
      ];

      sshExec(conn, 'bash <(curl -s https://pterodactyl-installer.se)', jobId, wingsPrompts, (code) => {
        sendEvent(jobId, 'progress', { pct: 82 });
        sendEvent(jobId, 'log', { msg: `✅ Wings terinstal!`, type: 'success' });

        // ── Step 3: Create Node ──
        sendEvent(jobId, 'log', { msg: `Membuat node otomatis...`, type: 'info' });

        const nodePrompts = [
          ['Masukkan nama lokasi: ',         'Singapore'],
          ['Masukkan deskripsi lokasi: ',    'Node By Wanzz'],
          ['Masukkan domain: ',              domainNode],
          ['Masukkan nama node: ',           'WanzzNode'],
          ['Masukkan RAM (dalam MB): ',      ram],
          ['Masukkan jumlah maksimum disk',  ram],
          ['Masukkan Locid: ',               '1'],
        ];

        sshExec(
          conn,
          'bash <(curl -s https://raw.githubusercontent.com/SkyzoOffc/Pterodactyl-Theme-Autoinstaller/main/createnode.sh)',
          jobId,
          nodePrompts,
          (code) => {
            sendEvent(jobId, 'progress', { pct: 100 });
            sendEvent(jobId, 'log', { msg: `🎉 Semua proses selesai!`, type: 'success' });
            sendEvent(jobId, 'done', {
              username: 'admin',
              password: panelPass,
              domain: domainPanel,
              ip: ip,
            });
            conn.end();
          }
        );
      });
    });
  });

  conn.on('error', (err) => {
    sendEvent(jobId, 'log', { msg: `❌ Gagal konek SSH: ${err.message}`, type: 'error' });
    sendEvent(jobId, 'error', { msg: err.message });
  });

  conn.connect(connSettings);
}

// ─────────────────────────────────────────
// POST /wings  — Start Wings
// ─────────────────────────────────────────
app.post('/wings', (req, res) => {
  const { ip, password, token } = req.body;
  if (!ip || !password || !token) return res.status(400).json({ error: 'Field tidak lengkap' });

  const jobId = 'wings_' + Date.now();
  jobs[jobId] = { clients: [] };
  res.json({ jobId });

  setTimeout(() => runWings(jobId, { ip, password, token }), 200);
});

async function runWings(jobId, { ip, password, token }) {
  const conn = new Client();
  sendEvent(jobId, 'log', { msg: `Menghubungkan ke ${ip}:22...`, type: 'info' });

  conn.on('ready', () => {
    sendEvent(jobId, 'log', { msg: `✅ SSH berhasil ke root@${ip}`, type: 'success' });

    const command = `${token} && systemctl enable --now wings`;
    sshExec(conn, command, jobId, [['(yes/no)', 'yes'], ['(y/N)', 'y']], (code) => {
      sendEvent(jobId, 'log', { msg: `✅ Wings berhasil dijalankan!`, type: 'success' });
      sendEvent(jobId, 'done', { msg: 'Wings aktif' });
      conn.end();
    });
  });

  conn.on('error', (err) => {
    sendEvent(jobId, 'log', { msg: `❌ Gagal: ${err.message}`, type: 'error' });
    sendEvent(jobId, 'error', { msg: err.message });
  });

  conn.connect({ host: ip, port: 22, username: 'root', password, readyTimeout: 15000 });
}

// ─────────────────────────────────────────
// POST /check-vps  — Cek status VPS via SSH
// ─────────────────────────────────────────
app.post('/check-vps', (req, res) => {
  const { ip, password } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP wajib diisi' });

  const conn = new Client();
  const start = Date.now();

  conn.on('ready', () => {
    const ping = Date.now() - start;
    conn.exec('uptime', (err, stream) => {
      let uptime = '';
      if (!err) {
        stream.on('data', d => uptime += d.toString());
        stream.on('close', () => {
          conn.end();
          res.json({ status: 'online', ping, uptime: uptime.trim() });
        });
      } else {
        conn.end();
        res.json({ status: 'online', ping, uptime: '' });
      }
    });
  });

  conn.on('error', () => {
    res.json({ status: 'offline', ping: null, uptime: '' });
  });

  conn.connect({
    host: ip, port: 22, username: 'root',
    password: password || '',
    readyTimeout: 8000,
  });
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚡ WANZZ INSTALLER SERVER running at http://localhost:${PORT}`);
  console.log(`   Buka browser: http://localhost:${PORT}/wanzz-installer.html\n`);
});
