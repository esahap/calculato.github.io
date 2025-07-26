// server.js - WebSocket сервер для Phantom Chat
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS для всіх доменів
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'PHANTOM SERVER ONLINE',
        timestamp: new Date().toISOString(),
        connections: wss.clients.size
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// WebSocket Server
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false
});

// Зберігання активних з'єднань
const activeConnections = new Map();
const rooms = new Map();

// Максимум 2 користувача в кімнаті
const MAX_USERS_PER_ROOM = 2;
const ROOM_ID = 'phantom_secure';

wss.on('connection', (ws, req) => {
    console.log(`New connection from ${req.socket.remoteAddress}`);
    
    let userId = null;
    let userFingerprint = null;
    
    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Invalid message format:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        if (userId) {
            handleUserDisconnect(userId);
        }
        console.log(`Connection closed for user ${userId}`);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    function handleMessage(ws, message) {
        const { type } = message;

        switch (type) {
            case 'join':
            case 'phantom_join':
                handleJoin(ws, message);
                break;

            case 'auth_challenge':
                handleAuthChallenge(ws, message);
                break;

            case 'join_secure_room':
                handleJoinSecureRoom(ws, message);
                break;

            case 'message':
            case 'encrypted_message':
            case 'phantom_encrypted_message':
                handleEncryptedMessage(ws, message);
                break;

            case 'key_exchange':
                handleKeyExchange(ws, message);
                break;

            case 'heartbeat':
                handleHeartbeat(ws, message);
                break;

            case 'leave':
                handleLeave(ws, message);
                break;

            default:
                console.log('Unknown message type:', type);
        }
    }

    function handleJoin(ws, message) {
        userId = message.userId;
        userFingerprint = message.fingerprint || generateFingerprint(req);
        
        // Перевіряємо кількість користувачів
        if (!rooms.has(ROOM_ID)) {
            rooms.set(ROOM_ID, new Set());
        }
        
        const room = rooms.get(ROOM_ID);
        
        if (room.size >= MAX_USERS_PER_ROOM) {
            ws.send(JSON.stringify({
                type: 'room_full',
                message: 'Maximum users reached'
            }));
            ws.close();
            return;
        }

        // Додаємо користувача
        activeConnections.set(userId, {
            ws,
            fingerprint: userFingerprint,
            joinTime: Date.now(),
            authenticated: false
        });
        
        room.add(userId);
        
        // Повідомляємо про успішну автентифікацію
        ws.send(JSON.stringify({
            type: 'auth_success',
            token: generateAuthToken(userId, userFingerprint),
            timestamp: Date.now()
        }));

        // Якщо є інший користувач - повідомляємо обох
        if (room.size === 2) {
            broadcastToRoom(ROOM_ID, {
                type: 'partner_joined',
                userId: userId
            }, userId);
            
            // Повідомляємо новому користувачу про існуючого партнера
            const otherUserId = Array.from(room).find(id => id !== userId);
            if (otherUserId) {
                ws.send(JSON.stringify({
                    type: 'partner_joined',
                    userId: otherUserId
                }));
            }
        }

        console.log(`User ${userId} joined. Room size: ${room.size}`);
    }

    function handleAuthChallenge(ws, message) {
        // Простий auth для демо
        const { fingerprint, challenge, signature, publicKey, timestamp } = message;
        
        if (activeConnections.has(userId)) {
            const connection = activeConnections.get(userId);
            connection.authenticated = true;
            connection.publicKey = publicKey;
            
            ws.send(JSON.stringify({
                type: 'phantom_auth_success',
                token: generateAuthToken(userId, fingerprint),
                timestamp: Date.now()
            }));
        }
    }

    function handleJoinSecureRoom(ws, message) {
        const { token } = message;
        
        if (!validateAuthToken(token, userId)) {
            ws.send(JSON.stringify({
                type: 'auth_failed',
                message: 'Invalid token'
            }));
            return;
        }

        // Логіка аналогічна handleJoin
        if (!rooms.has(ROOM_ID)) {
            rooms.set(ROOM_ID, new Set());
        }
        
        const room = rooms.get(ROOM_ID);
        
        if (room.size >= MAX_USERS_PER_ROOM && !room.has(userId)) {
            ws.send(JSON.stringify({
                type: 'phantom_room_full',
                message: 'Maximum users reached'
            }));
            return;
        }

        if (!room.has(userId)) {
            room.add(userId);
        }

        if (room.size === 2) {
            broadcastToRoom(ROOM_ID, {
                type: 'phantom_partner_joined',
                userId: userId
            }, userId);
        }
    }

    function handleEncryptedMessage(ws, message) {
        const { to, from, message: encryptedData } = message;
        
        if (!activeConnections.has(to)) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Recipient not found'
            }));
            return;
        }

        const recipientConnection = activeConnections.get(to);
        recipientConnection.ws.send(JSON.stringify({
            type: message.type,
            message: encryptedData,
            from: from,
            timestamp: Date.now()
        }));
    }

    function handleKeyExchange(ws, message) {
        const { to, from, publicKey } = message;
        
        if (activeConnections.has(to)) {
            const recipientConnection = activeConnections.get(to);
            recipientConnection.ws.send(JSON.stringify({
                type: 'key_exchange',
                publicKey: publicKey,
                from: from
            }));
        }
    }

    function handleHeartbeat(ws, message) {
        ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            timestamp: Date.now()
        }));
    }

    function handleLeave(ws, message) {
        if (userId) {
            handleUserDisconnect(userId);
        }
    }

    function handleUserDisconnect(userId) {
        if (rooms.has(ROOM_ID)) {
            const room = rooms.get(ROOM_ID);
            room.delete(userId);
            
            // Повідомляємо інших користувачів
            broadcastToRoom(ROOM_ID, {
                type: 'partner_left',
                userId: userId
            }, userId);
            
            if (room.size === 0) {
                rooms.delete(ROOM_ID);
            }
        }
        
        activeConnections.delete(userId);
    }
});

function broadcastToRoom(roomId, message, excludeUserId = null) {
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    room.forEach(userId => {
        if (userId !== excludeUserId && activeConnections.has(userId)) {
            const connection = activeConnections.get(userId);
            if (connection.ws.readyState === WebSocket.OPEN) {
                connection.ws.send(JSON.stringify(message));
            }
        }
    });
}

function generateFingerprint(req) {
    const ip = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    return require('crypto').createHash('sha256')
        .update(ip + userAgent + Date.now())
        .digest('hex');
}

function generateAuthToken(userId, fingerprint) {
    const payload = { userId, fingerprint, timestamp: Date.now() };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function validateAuthToken(token, userId) {
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        return payload.userId === userId && 
               (Date.now() - payload.timestamp) < 3600000; // 1 година
    } catch {
        return false;
    }
}

// Heartbeat для очищення мертвих з'єднань
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Очищення старих кімнат
setInterval(() => {
    rooms.forEach((room, roomId) => {
        if (room.size === 0) {
            rooms.delete(roomId);
        }
    });
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Phantom Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for secure connections`);
});