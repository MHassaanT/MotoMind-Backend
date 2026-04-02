require('dotenv').config()
const express = require('express')
const cors = require('cors')
const admin = require('firebase-admin')
const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')
const fs = require('fs')
const path = require('path')

// ─── Firebase Admin ───────────────────────────────────────────────────────────
let serviceAccount
const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64

if (base64Key) {
    try {
        const decoded = Buffer.from(base64Key, 'base64').toString('utf-8')
        serviceAccount = JSON.parse(decoded)
        console.log('[Firebase] Initialized using Base64 environment variable')
    } catch (err) {
        console.error('[Firebase] Failed to decode FIREBASE_SERVICE_ACCOUNT_BASE64')
    }
}

if (!serviceAccount) {
    try {
        serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json')
        console.log('[Firebase] Initialized using local serviceAccountKey.json')
    } catch {
        console.warn('[Firebase] No service account file found. Falling back to individual env vars.')
    }
}

admin.initializeApp({
    credential: serviceAccount
        ? admin.credential.cert(serviceAccount)
        : admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
})

const db = admin.firestore()

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
const clients = {} // { clientId: clientInstance }
let waQR = null
let waConnected = false

/**
 * Automagically clear stale Chromium lock files to prevent "profile in use" errors.
 */
function deleteStaleLocks(clientId) {
    const authDir = process.env.WWEBJS_AUTH_DIR || path.join(__dirname, '.wwebjs_auth')
    const sessionPath = path.join(authDir, `session-${clientId}`)
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
    
    lockFiles.forEach(file => {
        const filePath = path.join(sessionPath, file)
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
                console.log(`[WA] Removed stale lock file: ${file}`)
            }
        } catch (err) {
            console.error(`[WA] Failed to remove ${file}:`, err.message)
        }
    })
}

async function createWAClient(clientId = 'motomind') {
    if (clients[clientId]) {
        console.log(`[WA] Client for ${clientId} already exists. Returning existing.`)
        return clients[clientId]
    }

    console.log(`[WA] Preparing to launch WhatsApp client for ${clientId}...`)
    deleteStaleLocks(clientId)

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId,
            dataPath: process.env.WWEBJS_AUTH_DIR || path.join(__dirname, '.wwebjs_auth')
        }),
        puppeteer: {
            handleSIGINT: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--single-process'
            ],
        },
    })

    client.on('qr', async (qr) => {
        waQR = await qrcode.toDataURL(qr)
        waConnected = false
        console.log('[WA] QR generated')
    })

    client.on('ready', () => {
        waConnected = true
        waQR = null
        console.log('[WA] Connected!')
    })

    client.on('auth_failure', () => {
        waConnected = false
        console.log('[WA] Auth failure')
    })

    client.on('disconnected', () => {
        waConnected = false
        waQR = null
        delete clients[clientId]
        console.log('[WA] Disconnected')
    })

    try {
        await client.initialize()
        clients[clientId] = client
        console.log(`[WA] Initialized client for ${clientId}`)
    } catch (err) {
        console.error(`[WA] Initialization failed for ${clientId}:`, err.message)
        delete clients[clientId]
    }

    return client
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split('Bearer ')[1]
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.uid = decoded.uid
        req.displayName = decoded.name || 'Workshop'
        next()
    } catch {
        res.status(401).json({ error: 'Invalid token' })
    }
}

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express()
app.use(cors({ origin: '*' })) // Allow all origins to fix custom domain CORS issues
app.use(express.json())

// ─── Records Routes ───────────────────────────────────────────────────────────

// GET /api/records/stats
app.get('/api/records/stats', authMiddleware, async (req, res) => {
    try {
        const snapshot = await db.collection('records')
            .where('uid', '==', req.uid)
            .get()

        const records = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
        const now = new Date()
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay())
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

        res.json({
            total: records.length,
            finalized: records.filter(r => r.finalized).length,
            drafts: records.filter(r => !r.finalized).length,
            reminders: records.filter(r => r.finalized && new Date(r.currentDate) <= thirtyDaysAgo).length,
            today: records.filter(r => new Date(r.createdAt) >= startOfDay).length,
            thisWeek: records.filter(r => new Date(r.createdAt) >= startOfWeek).length,
            thisMonth: records.filter(r => new Date(r.createdAt) >= startOfMonth).length,
        })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// GET /api/records/reminders — finalized records whose nextServiceDate has arrived
app.get('/api/records/reminders', authMiddleware, async (req, res) => {
    try {
        const snapshot = await db.collection('records')
            .where('uid', '==', req.uid)
            .get()
        const today = new Date().toISOString().split('T')[0]
        const results = snapshot.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(r => r.finalized && r.nextServiceDate && r.nextServiceDate <= today)
            .sort((a, b) => (a.nextServiceDate > b.nextServiceDate ? 1 : -1))
        res.json(results)
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// GET /api/records
app.get('/api/records', authMiddleware, async (req, res) => {
    try {
        // Fetch all records for this user — no orderBy/compound where to avoid index requirements
        const snapshot = await db.collection('records')
            .where('uid', '==', req.uid)
            .get()

        let results = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))

        // Filter by status in JS
        if (req.query.filter === 'finalized') results = results.filter(r => r.finalized)
        if (req.query.filter === 'draft') results = results.filter(r => !r.finalized)

        // Search in JS
        if (req.query.search) {
            const q = req.query.search.toLowerCase()
            results = results.filter(r =>
                r.name?.toLowerCase().includes(q) ||
                r.phone?.includes(q) ||
                r.bikeType?.toLowerCase().includes(q)
            )
        }

        // Sort newest first in JS
        results.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))

        res.json(results)
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// POST /api/records
app.post('/api/records', authMiddleware, async (req, res) => {
    try {
        const record = {
            ...req.body,
            uid: req.uid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
        const ref = await db.collection('records').add(record)
        res.status(201).json({ id: ref.id, ...record })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// PUT /api/records/:id
app.put('/api/records/:id', authMiddleware, async (req, res) => {
    try {
        const ref = db.collection('records').doc(req.params.id)
        const doc = await ref.get()
        if (!doc.exists || doc.data().uid !== req.uid)
            return res.status(404).json({ error: 'Not found' })
        const update = { ...req.body, updatedAt: new Date().toISOString() }
        await ref.update(update)
        res.json({ id: req.params.id, ...doc.data(), ...update })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// DELETE /api/records/:id
app.delete('/api/records/:id', authMiddleware, async (req, res) => {
    try {
        const ref = db.collection('records').doc(req.params.id)
        const doc = await ref.get()
        if (!doc.exists || doc.data().uid !== req.uid)
            return res.status(404).json({ error: 'Not found' })
        await ref.delete()
        res.json({ success: true })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// ─── WhatsApp Routes ──────────────────────────────────────────────────────────

// GET /api/wa/status
app.get('/api/wa/status', authMiddleware, (req, res) => {
    res.json({ connected: waConnected, qr: waQR })
})

// POST /api/wa/connect
app.post('/api/wa/connect', authMiddleware, async (req, res) => {
    const clientId = 'motomind'
    if (waConnected && clients[clientId]) return res.json({ status: 'already_connected' })
    
    // Always attempt to create/get client (it handles its own singleton logic and lock cleaning)
    try {
        await createWAClient(clientId)
        res.json({ status: 'connecting' })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// POST /api/wa/disconnect
app.post('/api/wa/disconnect', authMiddleware, async (req, res) => {
    const clientId = 'motomind'
    try {
        const client = clients[clientId]
        if (client) {
            await client.destroy()
            delete clients[clientId]
        }
        waConnected = false
        waQR = null
        res.json({ status: 'disconnected' })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// POST /api/wa/send-reminder/:id
app.post('/api/wa/send-reminder/:id', authMiddleware, async (req, res) => {
    const client = clients['motomind']
    if (!waConnected || !client) {
        return res.status(400).json({ error: 'WhatsApp not connected' })
    }
    try {
        const ref = db.collection('records').doc(req.params.id)
        const doc = await ref.get()
        if (!doc.exists || doc.data().uid !== req.uid)
            return res.status(404).json({ error: 'Record not found' })

        const r = doc.data()

        // Fix 3: Block if reminder already sent
        if (r.reminderSent) {
            return res.status(400).json({ error: 'Reminder already sent for this record' })
        }

        const message =
            `Hello ${r.name}! 🏍️\n\n` +
            `Your *${r.bikeType}* was last serviced at *${req.displayName}* on *${r.currentDate}* ` +
            `with a mileage of *${Number(r.kmReading).toLocaleString()} km*.\n\n` +
            `Your next service is due on *${r.nextServiceDate}*. ` +
            `Please visit us for a checkup! 🔧\n\n` +
            `_${req.displayName}_`

        // Format phone: remove spaces/dashes, ensure @c.us suffix
        let phone = r.phone.replace(/[\s\-\(\)]/g, '')
        if (!phone.startsWith('+')) phone = '+' + phone
        phone = phone.replace('+', '') + '@c.us'

        await client.sendMessage(phone, message)

        // Mark as sent so it cannot be sent again
        await ref.update({ reminderSent: true, reminderSentAt: new Date().toISOString() })

        res.json({ success: true })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})



// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
    console.log(`✅ MotoMind backend running on http://localhost:${PORT}`)
})
