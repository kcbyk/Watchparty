const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const yts = require('yt-search');
const path = require('path');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── YouTube Media Downloader API (RapidAPI & Direct Engine) ──────────────────
const RAPIDAPI_DOWNLOAD_KEYS = [
  'cb858c97a3msh3798faa4195f2c4p1ce356jsnfed9edfcad6f',
  'bb06a77a1dmshf74916c37643f8ap1e4682jsn88e788cec36a'
];

if (process.env.RAPIDAPI_KEY) {
  RAPIDAPI_DOWNLOAD_KEYS.unshift(process.env.RAPIDAPI_KEY.trim());
}

let downloadKeyIndex = 0;

function getDownloadKey() {
  return RAPIDAPI_DOWNLOAD_KEYS[downloadKeyIndex % RAPIDAPI_DOWNLOAD_KEYS.length];
}
function rotateDownloadKey() {
  downloadKeyIndex = (downloadKeyIndex + 1) % RAPIDAPI_DOWNLOAD_KEYS.length;
}

// ─── MP3 API (youtube-mp36) — direkt indirilebilir link verir (Otomatik Polling) ───
async function fetchMp3Link(videoId) {
  for (let attempt = 0; attempt < RAPIDAPI_DOWNLOAD_KEYS.length; attempt++) {
    const key = RAPIDAPI_DOWNLOAD_KEYS[attempt];
    try {
      for (let poll = 0; poll < 4; poll++) {
        const res = await fetch(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
          headers: {
            'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
            'x-rapidapi-key': key
          }
        });
        if (!res.ok) break;
        const data = await res.json();
        if (data.status === 'ok' && data.link) return data;
        if (data.status === 'processing' || data.msg === 'in progress') {
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
        break;
      }
    } catch (e) {
      console.warn('[fetchMp3Link Warning]', e.message);
    }
  }
  return null;
}

async function fetchVideoDetails(videoId) {
  for (let attempt = 0; attempt < RAPIDAPI_DOWNLOAD_KEYS.length; attempt++) {
    const key = getDownloadKey();
    try {
      const res = await fetch(
        `https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${videoId}`,
        { headers: { 'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com', 'x-rapidapi-key': key } }
      );
      const data = await res.json();
      if (data.errorId === 'Success') return data;
      if (data.message && (data.message.includes('Too many') || data.message.includes('rate'))) {
        rotateDownloadKey();
        continue;
      }
      return null;
    } catch (e) {
      rotateDownloadKey();
    }
  }
  return null;
}

// ─── Download Info Route ───────────────────────────────────────────────────────
app.get('/api/download-info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Geçersiz video ID' });
  }

  try {
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // MP3 ve video detaylarını paralel çek
    const [mp3Data, videoData] = await Promise.all([
      fetchMp3Link(videoId),
      fetchVideoDetails(videoId)
    ]);

    // MP4 seçenekleri
    const allowedQualities = ['1080p', '720p', '480p', '360p'];
    const videoOptions = videoData ? (videoData.videos?.items || [])
      .filter(v => v.extension === 'mp4' && allowedQualities.includes(v.quality))
      .reduce((acc, v) => {
        if (!acc.find(x => x.quality === v.quality)) acc.push(v);
        return acc;
      }, [])
      .sort((a, b) => parseInt(b.quality) - parseInt(a.quality))
      .slice(0, 4) : [];

    const title = mp3Data?.title || videoData?.title || 'video';

    res.json({
      title,
      thumbnail,
      mp3: mp3Data ? { url: mp3Data.link, size: mp3Data.filesize } : null,
      videos: videoOptions
    });
  } catch (err) {
    console.error('[Download Info Error]', err.message);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ─── Proxy Download Route (CORS bypass & High-Speed Stream) ───────────────────
app.get('/api/proxy-download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('URL gerekli');

  try {
    const decodedUrl = decodeURIComponent(url);

    if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
      return res.status(400).send('Geçersiz URL');
    }

    const upstream = await fetch(decodedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    if (!upstream.ok) {
      console.warn('[Proxy Download Upstream Warning]', upstream.status, decodedUrl);
      // If direct stream fails, redirect directly as fallback
      return res.redirect(decodedUrl);
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const contentLength = upstream.headers.get('content-length');
    let safeFilename = (filename || 'sarki.mp3').replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (!safeFilename.endsWith('.mp3') && !safeFilename.endsWith('.mp4')) {
      safeFilename += '.mp3';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Stream body directly for instant download
    const { Readable } = require('stream');
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const buf = await upstream.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error('[Proxy Download Error]', err.message);
    if (!res.headersSent) {
      res.status(500).send('İndirme hatası');
    }
  }
});

// ─── Direct Audio Stream Endpoint (For Background Lock-Screen Audio Playback) ──
app.get('/api/stream-audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Geçersiz video ID');
  }

  try {
    const mp3Data = await fetchMp3Link(videoId);
    if (!mp3Data || !mp3Data.link) {
      return res.status(404).send('MP3 akışı hazırlanamadı');
    }

    const upstream = await fetch(mp3Data.link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    if (!upstream.ok) {
      return res.redirect(mp3Data.link);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const { Readable } = require('stream');
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const buf = await upstream.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error('[Stream Audio Error]', err.message);
    if (!res.headersSent) res.status(500).send('Ses akışı hatası');
  }
});

// Persistent Room Storage backed by SQLite
const rooms = db.loadAllRooms();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const newRoom = {
      users: [],
      queue: [],
      currentVideo: null,
      videoState: { playing: false, time: 0, updatedAt: Date.now() },
      messages: []
    };
    rooms.set(roomId, newRoom);
    db.saveRoom(roomId, newRoom);
  }
  return rooms.get(roomId);
}

// Helper to save room state to SQLite
function persistRoom(roomId) {
  const r = rooms.get(roomId);
  if (r) db.saveRoom(roomId, r);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/new-room', (req, res) => {
  let id;
  do { id = generateRoomId(); } while (rooms.has(id));
  res.json({ roomId: id });
});

// ─── High-Quality Built-in Seed Videos (Instant Zero-Latency Fallback) ───────
const SEED_VIDEOS = [
  {
    id: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    duration: "3:33",
    author: "Rick Astley",
    channelAvatar: "",
    subCount: "4,2 Mn abone",
    ago: "14 yıl önce",
    views: "1,5 Mr görüntüleme"
  },
  {
    id: "kJQP7kiw5Fk",
    title: "Luis Fonsi - Despacito ft. Daddy Yankee",
    thumbnail: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
    duration: "4:42",
    author: "Luis Fonsi",
    channelAvatar: "",
    subCount: "31 Mn abone",
    ago: "7 yıl önce",
    views: "8,4 Mr görüntüleme"
  },
  {
    id: "9bZkp7q19f0",
    title: "PSY - GANGNAM STYLE (강남스타일) M/V",
    thumbnail: "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg",
    duration: "4:13",
    author: "officialpsy",
    channelAvatar: "",
    subCount: "19 Mn abone",
    ago: "12 yıl önce",
    views: "5,1 Mr görüntüleme"
  },
  {
    id: "fJ9rUzIMcZQ",
    title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
    thumbnail: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
    duration: "5:59",
    author: "Queen Official",
    channelAvatar: "",
    subCount: "17 Mn abone",
    ago: "15 yıl önce",
    views: "1,7 Mr görüntüleme"
  },
  {
    id: "JGwWNGJdvx8",
    title: "Ed Sheeran - Shape of You (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg",
    duration: "4:24",
    author: "Ed Sheeran",
    channelAvatar: "",
    subCount: "54 Mn abone",
    ago: "7 yıl önce",
    views: "6,2 Mr görüntüleme"
  },
  {
    id: "OPf0YbXqDm0",
    title: "Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars",
    thumbnail: "https://i.ytimg.com/vi/OPf0YbXqDm0/hqdefault.jpg",
    duration: "4:31",
    author: "Mark Ronson",
    channelAvatar: "",
    subCount: "11 Mn abone",
    ago: "9 yıl önce",
    views: "5,2 Mr görüntüleme"
  },
  {
    id: "RgKAFK5djSk",
    title: "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack",
    thumbnail: "https://i.ytimg.com/vi/RgKAFK5djSk/hqdefault.jpg",
    duration: "3:58",
    author: "Wiz Khalifa",
    channelAvatar: "",
    subCount: "29 Mn abone",
    ago: "9 yıl önce",
    views: "6,1 Mr görüntüleme"
  },
  {
    id: "09R8_2nJtjg",
    title: "Maroon 5 - Sugar (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/09R8_2nJtjg/hqdefault.jpg",
    duration: "5:01",
    author: "Maroon 5",
    channelAvatar: "",
    subCount: "36 Mn abone",
    ago: "9 yıl önce",
    views: "4,0 Mr görüntüleme"
  },
  {
    id: "hT_nvWreIhg",
    title: "OneRepublic - Counting Stars (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/hT_nvWreIhg/hqdefault.jpg",
    duration: "4:44",
    author: "OneRepublic",
    channelAvatar: "",
    subCount: "10 Mn abone",
    ago: "11 yıl önce",
    views: "4,0 Mr görüntüleme"
  },
  {
    id: "CevxZvSJLk8",
    title: "Katy Perry - Roar (Official)",
    thumbnail: "https://i.ytimg.com/vi/CevxZvSJLk8/hqdefault.jpg",
    duration: "4:30",
    author: "Katy Perry",
    channelAvatar: "",
    subCount: "45 Mn abone",
    ago: "10 yıl önce",
    views: "4,0 Mr görüntüleme"
  },
  {
    id: "uelHwf8o7_U",
    title: "Eminem - Love The Way You Lie ft. Rihanna",
    thumbnail: "https://i.ytimg.com/vi/uelHwf8o7_U/hqdefault.jpg",
    duration: "4:27",
    author: "EminemMusic",
    channelAvatar: "",
    subCount: "59 Mn abone",
    ago: "14 yıl önce",
    views: "2,8 Mr görüntüleme"
  },
  {
    id: "YQHsXMglC9A",
    title: "Adele - Hello (Official Music Video)",
    thumbnail: "https://i.ytimg.com/vi/YQHsXMglC9A/hqdefault.jpg",
    duration: "6:07",
    author: "Adele",
    channelAvatar: "",
    subCount: "30 Mn abone",
    ago: "8 yıl önce",
    views: "3,1 Mr görüntüleme"
  }
];

// ─── Ultra-Fast Multi-Engine YouTube Search & In-Memory Cache ────────────────
const defaultKeys = [
  'AIzaSyBAGhhAJrcy8SElpcZqv2autfI6wWMQbvI',
  'AIzaSyBW6k17K4LC24XLfiDjP37Hlx2cBexyztc'
];

let envKeys = [];
if (process.env.YOUTUBE_API_KEY) {
  envKeys.push(...process.env.YOUTUBE_API_KEY.split(',').map(k => k.trim()).filter(Boolean));
}
if (process.env.YOUTUBE_API_KEY_2) {
  envKeys.push(process.env.YOUTUBE_API_KEY_2.trim());
}

const YOUTUBE_API_KEYS = envKeys.length > 0 ? envKeys : defaultKeys;
let currentApiKeyIndex = 0;

function getActiveApiKey() {
  return YOUTUBE_API_KEYS[currentApiKeyIndex % YOUTUBE_API_KEYS.length];
}

function rotateApiKey() {
  currentApiKeyIndex = (currentApiKeyIndex + 1) % YOUTUBE_API_KEYS.length;
  console.log(`[API Key Rotated] Active key index: ${currentApiKeyIndex}`);
}

// ─── High-Speed RAM Cache (0ms instant response) ────────────────────────────
const searchCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedResults(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCachedResults(key, data) {
  if (!Array.isArray(data) || data.length === 0) return;
  // Limit cache size to 500 items
  if (searchCache.size > 500) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(key, { time: Date.now(), data });
}

// ISO 8601 Duration Parser (e.g. PT4M13S -> 4:13)
function parseYouTubeDuration(duration) {
  if (!duration) return '?:??';
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '?:??';
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ─── Utility helpers (module-scope — used by all search engines) ──────────────
function cleanText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function getChannelAvatarFallback(author) {
  const name = (author || 'YouTube').trim();
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff&size=128&bold=true&format=svg`;
}

// ─── 0. Native YouTube HTML Scraper (Direct & Zero Quota Limit) ─────────────
async function searchDirectYouTube(query, maxResults = 24) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/s);
    if (!match) return [];
    
    const data = JSON.parse(match[1]);
    const sectionList = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    let items = [];
    for (const section of sectionList) {
      const contents = section?.itemSectionRenderer?.contents || [];
      for (const item of contents) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          if (!v.videoId) continue;
          const title = cleanText(v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || 'YouTube Video');
          const author = cleanText(v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || 'YouTube');
          const rawAvatar = v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url || '';
          const channelAvatar = rawAvatar ? (rawAvatar.startsWith('//') ? 'https:' + rawAvatar : rawAvatar) : getChannelAvatarFallback(author);
          const views = v.viewCountText?.simpleText || v.viewCountText?.runs?.map(r => r.text).join('') || '';
          const ago = v.publishedTimeText?.simpleText || '';
          const duration = v.lengthText?.simpleText || '?:??';
          const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
          
          items.push({
            id: v.videoId,
            title,
            author,
            channelAvatar,
            subCount: '1,24 Mn abone',
            views,
            ago,
            duration,
            thumbnail: thumb.startsWith('//') ? 'https:' + thumb : thumb
          });
        }
      }
    }
    return items.slice(0, maxResults);
  } catch (err) {
    console.warn('[Direct Scraper Warning]', err.message);
    return [];
  }
}

// 1. Official Google YouTube Data API v3 (Ultra-Fast ~120ms with rotating keys)
async function searchWithYouTubeDataApi(query, maxResults = 24) {
  for (let attempt = 0; attempt < YOUTUBE_API_KEYS.length; attempt++) {
    const key = getActiveApiKey();
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${key}`;
      const res = await fetch(searchUrl);
      
      if (res.status === 403 || res.status === 429) {
        console.warn(`[YouTube Data API Quota Warning on key ${currentApiKeyIndex}] Rotating key...`);
        rotateApiKey();
        continue;
      }
      
      if (!res.ok) return [];
      const data = await res.json();
      const videoIds = (data.items || []).map(i => i.id?.videoId).filter(Boolean);

      if (videoIds.length === 0) return [];

      // Fetch video details in parallel for accurate duration & view count
      let videoDetailsMap = {};
      let channelIds = new Set();
      try {
        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${videoIds.join(',')}&key=${key}`;
        const detailsRes = await fetch(detailsUrl);
        if (detailsRes.ok) {
          const detailsData = await detailsRes.json();
          (detailsData.items || []).forEach(item => {
            if (item.snippet?.channelId) channelIds.add(item.snippet.channelId);
            videoDetailsMap[item.id] = {
              channelId: item.snippet?.channelId,
              duration: parseYouTubeDuration(item.contentDetails?.duration),
              views: item.statistics?.viewCount ? (Number(item.statistics.viewCount).toLocaleString('tr-TR') + ' görüntüleme') : ''
            };
          });
        }
      } catch (_) {}

      // Fetch channel avatars & subscriber counts in parallel
      let channelDetailsMap = {};
      if (channelIds.size > 0) {
        try {
          const chanUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${Array.from(channelIds).join(',')}&key=${key}`;
          const chanRes = await fetch(chanUrl);
          if (chanRes.ok) {
            const chanData = await chanRes.json();
            (chanData.items || []).forEach(c => {
              const subs = c.statistics?.subscriberCount;
              let subText = 'Abone';
              if (subs) {
                const num = Number(subs);
                if (num >= 1000000) subText = `${(num/1000000).toFixed(1).replace('.', ',')} Mn abone`;
                else if (num >= 1000) subText = `${Math.round(num/1000)} B abone`;
                else subText = `${num} abone`;
              }
              channelDetailsMap[c.id] = {
                avatar: c.snippet?.thumbnails?.default?.url || c.snippet?.thumbnails?.medium?.url || '',
                subCount: subText
              };
            });
          }
        } catch (_) {}
      }

      return (data.items || []).map(item => {
        const vId = item.id?.videoId;
        const details = videoDetailsMap[vId] || {};
        const chDetails = (details.channelId && channelDetailsMap[details.channelId]) ? channelDetailsMap[details.channelId] : {};
        const authorName = cleanText(item.snippet?.channelTitle) || 'YouTube Kanalı';
        return {
          id: vId,
          title: cleanText(item.snippet?.title) || 'YouTube Video',
          thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
          duration: details.duration || '?:??',
          author: authorName,
          channelId: details.channelId || item.snippet?.channelId || '',
          channelAvatar: chDetails.avatar || getChannelAvatarFallback(authorName),
          subCount: chDetails.subCount || '1,24 Mn abone',
          ago: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt).toLocaleDateString('tr-TR') : '',
          views: details.views || ''
        };
      }).filter(v => v.id);
    } catch (e) {
      console.warn('[YouTube Data API Warning]', e.message);
      rotateApiKey();
    }
  }
  return [];
}

// 2. Secondary Scraper: Direct HTML scraper fallback
async function searchWithYts(query) {
  try {
    const directRes = await searchDirectYouTube(query, 20);
    if (Array.isArray(directRes) && directRes.length > 0) {
      return directRes;
    }
    const r = await yts(query);
    return (r.videos || [])
      .filter(v => v && v.videoId)
      .map(v => {
        const authorName = typeof v.author === 'string' ? v.author : (v.author?.name || 'YouTube');
        const chAvatar = (typeof v.author === 'object' && v.author?.avatar) ? v.author.avatar : getChannelAvatarFallback(authorName);
        return {
          id: v.videoId,
          title: typeof v.title === 'string' ? v.title : (v.title?.text || String(v.title || 'YouTube Video')),
          thumbnail: v.thumbnail || v.image || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          duration: v.timestamp || '?:??',
          author: authorName,
          channelAvatar: chAvatar,
          subCount: '1,24 Mn abone',
          ago: v.ago || '',
          views: v.views ? (typeof v.views === 'number' ? (v.views.toLocaleString('tr-TR') + ' görüntüleme') : String(v.views)) : ''
        };
      });
  } catch (e) {
    return [];
  }
}

// 3. Fallback: Public Invidious API
async function searchWithInvidious(query) {
  const instances = [
    'https://inv.nadeko.net/api/v1/search',
    'https://invidious.privacydev.net/api/v1/search',
    'https://vid.puffyan.us/api/v1/search'
  ];

  for (const inst of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${inst}?q=${encodeURIComponent(query)}&type=video`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(v => {
          const authorName = v.author || 'YouTube';
          return {
            id: v.videoId,
            title: v.title || 'YouTube Video',
            thumbnail: v.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
            duration: v.lengthSeconds ? `${Math.floor(v.lengthSeconds/60)}:${String(v.lengthSeconds%60).padStart(2,'0')}` : '?:??',
            author: authorName,
            channelAvatar: getChannelAvatarFallback(authorName),
            ago: v.publishedText || '',
            views: v.viewCount ? (Number(v.viewCount).toLocaleString('tr-TR') + ' görüntüleme') : ''
          };
        }).filter(v => v.id);
      }
    } catch (_) {}
  }
  return [];
}

// ─── AI Personalized Recommendation Feed Route ────────────────────────────
app.get('/api/ai-feed', async (req, res) => {
  try {
    const rawContext = req.query.context || '';
    const seed = req.query.seed || '0';
    let userKeywords = [];
    if (rawContext) {
      userKeywords = rawContext.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Diverse discovery pool — 24 queries for maximum variety
    const discoveryPool = [
      'trend popüler türkiye 2025',
      'yeni çıkan hit şarkılar klip',
      'viral şarkılar trendler 2025',
      'türkçe rap hiphop yeni',
      'türkçe pop en çok dinlenen',
      'en iyi akustik canlı performans',
      'dünya trend müzikler',
      'global hit music 2025',
      'en çok izlenen müzik klipleri',
      'türkçe arabesk duygusal şarkılar',
      'pop müzik yeni album',
      'rock alternatíf müzik 2025',
      'elektronik müzik trap edm',
      'chill lo-fi study music',
      'klasik rock efsane şarkılar',
      'r&b soul müzik yeni',
      'k-pop hit songs 2025',
      'latin pop reggaeton hits',
      'turkish music best songs',
      'jazz blues relaxing music',
      'hip hop rap best tracks',
      'indie alternative new music',
      'country music popular songs',
      'reggae dancehall hits'
    ];

    let targetQueries = [];
    if (userKeywords.length > 0) {
      // Kişisel kullanıcı ilgi alanları
      const shuffled = [...userKeywords].sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, 2);
      targetQueries.push(`${selected.join(' ')} popüler`);
      if (selected[0]) targetQueries.push(`${selected[0]} benzeri şarkılar`);
    }
    
    // Keşif havuzundan iki farklı sorgu seç (daha fazla çeşitlilik)
    const seedNum = Math.abs(parseInt(seed, 10) || 0);
    const discQ1 = discoveryPool[seedNum % discoveryPool.length];
    const discQ2 = discoveryPool[(seedNum + Math.floor(discoveryPool.length / 2)) % discoveryPool.length];
    targetQueries.push(discQ1);
    if (discQ1 !== discQ2) targetQueries.push(discQ2);

    let combinedVideos = [];
    for (const q of targetQueries) {
      let results = await searchWithYouTubeDataApi(q, 12);
      if (!results || results.length === 0) {
        results = await searchWithYts(q);
      }
      if (Array.isArray(results)) {
        combinedVideos.push(...results);
      }
    }

    // Deduplicate & ensure profile pictures
    const seen = new Set();
    const cleanList = [];
    for (const v of combinedVideos) {
      if (!v || !v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      if (!v.channelAvatar) {
        v.channelAvatar = getChannelAvatarFallback(v.author);
      }
      cleanList.push(v);
    }

    // Shuffle results for more variety on each call
    for (let i = cleanList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cleanList[i], cleanList[j]] = [cleanList[j], cleanList[i]];
    }

    // No-cache headers so browser always fetches fresh
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    if (cleanList.length === 0) {
      return res.json(SEED_VIDEOS.map(v => ({
        ...v,
        channelAvatar: v.channelAvatar || getChannelAvatarFallback(v.author)
      })));
    }

    res.json(cleanList.slice(0, 24));
  } catch (err) {
    console.error('[AI Feed Error]', err.message);
    res.json(SEED_VIDEOS);
  }
});

// ─── Search Route with Instant RAM Cache & Parallel Multi-Engine ────────────
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const fresh = !!req.query._t; // bypass cache when _t timestamp is present
  if (!q) return res.json([]);

  const cacheKey = `${q.toLowerCase()}_p${page}_l${limit}`;

  // 1. RAM Cache Hit (skip if fresh request)
  if (!fresh) {
    const cached = getCachedResults(cacheKey);
    if (cached) return res.json(cached);

    // 2. SQLite Cache Hit (skip if fresh)
    const dbCached = db.getCachedSearch(cacheKey);
    if (dbCached) {
      setCachedResults(cacheKey, dbCached);
      return res.json(dbCached);
    }
  }

  const queryTerm = page > 1 ? `${q} ${['yeni', 'popüler', 'trend', '2026', 'en iyi'][page % 5]}` : q;

  try {
    // 3. Primary Fast YouTube Data API v3 (Instant)
    let videos = await searchWithYouTubeDataApi(queryTerm, limit + 4);

    // 4. If Data API returned empty, try fast scraper (yts)
    if (!videos || videos.length === 0) {
      videos = await searchWithYts(queryTerm);
    }

    // 5. If still empty, try Invidious fallback
    if (!videos || videos.length === 0) {
      videos = await searchWithInvidious(queryTerm);
    }

    const startIndex = (page - 1) * limit;
    let paginatedVideos = (videos || []).slice(startIndex, startIndex + limit);
    let result = paginatedVideos.length > 0 ? paginatedVideos : (videos || []).slice(0, limit);

    // Cache the result in both RAM & SQLite if we found actual videos
    if (result.length > 0) {
      setCachedResults(cacheKey, result);
      db.setCachedSearch(cacheKey, q, result);
    }

    res.json(result);
  } catch (err) {
    console.error('[Search Global Fallback Error]', err.message);
    try {
      const fallbackVideos = await searchDirectYouTube(q, limit);
      if (Array.isArray(fallbackVideos) && fallbackVideos.length > 0) {
        return res.json(fallbackVideos);
      }
    } catch (_) {}
    res.json([]);
  }
});

// ─── Real-time YouTube Autocomplete Suggestions Route ───────────────────────
app.get('/api/suggestions', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const response = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data[1])) {
        return res.json(data[1].slice(0, 10));
      }
    }
  } catch (err) {
    console.warn('[Suggestions Error]', err.message);
  }
  res.json([]);
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let roomId = null;
  let username = null;

  socket.on('join-room', ({ room, user }) => {
    roomId = room.toUpperCase().trim();
    username = user.trim() || 'Misafir';
    socket.join(roomId);

    const r = getRoom(roomId);
    r.users.push({ id: socket.id, name: username });

    // Send full state to new joiner (including persistent chat history from DB)
    const elapsed = r.videoState.playing
      ? (Date.now() - r.videoState.updatedAt) / 1000
      : 0;

    const recentMessages = db.getRecentMessages(roomId);

    socket.emit('room-state', {
      video: r.currentVideo,
      videoState: { ...r.videoState, time: r.videoState.time + elapsed },
      queue: r.queue,
      users: r.users,
      messages: recentMessages.length > 0 ? recentMessages : r.messages.slice(-60)
    });

    // System message
    const sysMsg = { type: 'system', text: `${username} odaya katıldı 👋`, time: Date.now() };
    r.messages.push(sysMsg);
    db.saveMessage(roomId, sysMsg);
    io.to(roomId).emit('new-message', sysMsg);
    io.to(roomId).emit('users-updated', r.users);
  });

  socket.on('send-message', (text) => {
    if (!roomId || !text?.trim()) return;
    const r = rooms.get(roomId);
    if (!r) return;
    const msg = { type: 'user', name: username, text: text.trim(), time: Date.now() };
    r.messages.push(msg);
    db.saveMessage(roomId, msg);
    if (r.messages.length > 200) r.messages.shift();
    io.to(roomId).emit('new-message', msg);
  });

  socket.on('play-video-now', (video) => {
    if (!roomId || !video) return;
    const r = rooms.get(roomId);
    if (!r) return;

    r.currentVideo = { ...video, addedBy: username };
    r.videoState = { playing: true, time: 0, updatedAt: Date.now() };
    persistRoom(roomId);

    io.to(roomId).emit('video-changed', r.currentVideo);

    const sysMsg = {
      type: 'system',
      text: `${username} videoyu başlattı: "${video.title.substring(0, 45)}${video.title.length > 45 ? '…' : ''}"`,
      time: Date.now()
    };
    r.messages.push(sysMsg);
    db.saveMessage(roomId, sysMsg);
    io.to(roomId).emit('new-message', sysMsg);
  });

  socket.on('add-to-queue', (video) => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;

    r.queue.push({ ...video, addedBy: username });
    persistRoom(roomId);
    io.to(roomId).emit('queue-updated', r.queue);

    const sysMsg = {
      type: 'system',
      text: `${username} kuyruğa ekledi: "${video.title.substring(0, 45)}${video.title.length > 45 ? '…' : ''}"`,
      time: Date.now()
    };
    r.messages.push(sysMsg);
    db.saveMessage(roomId, sysMsg);
    io.to(roomId).emit('new-message', sysMsg);

    if (!r.currentVideo) playNext(roomId);
  });

  socket.on('remove-from-queue', (index) => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r || index < 0 || index >= r.queue.length) return;
    r.queue.splice(index, 1);
    persistRoom(roomId);
    io.to(roomId).emit('queue-updated', r.queue);
  });

  socket.on('video-play', (time) => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.videoState = { playing: true, time, updatedAt: Date.now() };
    persistRoom(roomId);
    socket.to(roomId).emit('video-play', time);
  });

  socket.on('video-pause', (time) => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.videoState = { playing: false, time, updatedAt: Date.now() };
    persistRoom(roomId);
    socket.to(roomId).emit('video-pause', time);
  });

  socket.on('video-seek', (time) => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.videoState.time = time;
    r.videoState.updatedAt = Date.now();
    persistRoom(roomId);
    socket.to(roomId).emit('video-seek', time);
  });

  socket.on('video-ended', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    // Only first user triggers next to avoid duplicate skips
    if (r.users.length === 0 || r.users[0].id === socket.id) {
      playNext(roomId);
    }
  });

  socket.on('skip', () => {
    if (!roomId) return;
    playNext(roomId);
  });

  socket.on('previous-track', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r || !r.history || r.history.length === 0) return;
    
    // Geçerli videoyu tekrar sıranın başına koy
    if (r.currentVideo) {
      r.queue.unshift(r.currentVideo);
    }
    
    // Geçmişteki son videoyu al
    r.currentVideo = r.history.pop();
    r.videoState = { playing: true, time: 0, updatedAt: Date.now() };
    persistRoom(roomId);
    io.to(roomId).emit('video-changed', r.currentVideo);
    io.to(roomId).emit('queue-updated', r.queue);
  });

  socket.on('request-sync', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r || !r.currentVideo) return;
    const elapsed = r.videoState.playing
      ? (Date.now() - r.videoState.updatedAt) / 1000
      : 0;
    socket.emit('sync', {
      video: r.currentVideo,
      time: r.videoState.time + elapsed,
      playing: r.videoState.playing
    });
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;

    r.users = r.users.filter(u => u.id !== socket.id);

    if (r.users.length === 0) {
      rooms.delete(roomId);
      return;
    }

    const sysMsg = { type: 'system', text: `${username} odadan ayrıldı`, time: Date.now() };
    r.messages.push(sysMsg);
    io.to(roomId).emit('new-message', sysMsg);
    io.to(roomId).emit('users-updated', r.users);
    io.to(roomId).emit('user-disconnected-call', { socketId: socket.id });
  });

  // ─── Call & WebRTC Signaling ───────────────────────────────────────────────
  socket.on('call-user', ({ targetSocketId, callType }) => {
    io.to(targetSocketId).emit('incoming-call', {
      callerSocketId: socket.id,
      callerName: username,
      callType
    });
  });

  socket.on('call-accepted', ({ callerSocketId }) => {
    io.to(callerSocketId).emit('call-accepted', {
      targetSocketId: socket.id,
      targetName: username
    });
  });

  socket.on('call-rejected', ({ callerSocketId }) => {
    io.to(callerSocketId).emit('call-rejected', {
      targetSocketId: socket.id,
      targetName: username
    });
  });

  socket.on('call-ended', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('call-ended', {
      fromSocketId: socket.id
    });
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', {
      fromSocketId: socket.id,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', {
      fromSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc-ice', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice', {
      fromSocketId: socket.id,
      candidate
    });
  });

  socket.on('user-speaking', ({ targetSocketId, isSpeaking }) => {
    io.to(targetSocketId).emit('user-speaking', {
      fromSocketId: socket.id,
      isSpeaking
    });
  });
});

// ─── Play Next ────────────────────────────────────────────────────────────────

function playNext(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;

  if (!r.history) r.history = [];
  if (r.currentVideo) {
    r.history.push(r.currentVideo);
    if (r.history.length > 50) r.history.shift();
  }

  if (r.queue.length === 0) {
    r.currentVideo = null;
    persistRoom(roomId);
    io.to(roomId).emit('video-changed', null);
    return;
  }

  r.currentVideo = r.queue.shift();
  r.videoState = { playing: true, time: 0, updatedAt: Date.now() };
  persistRoom(roomId);
  io.to(roomId).emit('video-changed', r.currentVideo);
  io.to(roomId).emit('queue-updated', r.queue);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════╗');
  console.log('║  🎬  WatchParty  Başlatıldı!   ║');
  console.log('╠════════════════════════════════╣');
  console.log(`║  🌐  http://localhost:${PORT}      ║`);
  console.log('╚════════════════════════════════╝\n');
});
