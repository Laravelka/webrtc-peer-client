const cuid = require('cuid')
const inherits = require('inherits')
const EventEmitter = require('nanobus')
const SimplePeer = require('simple-peer')

inherits(WebrtcPeerClient, EventEmitter)

const ERR_CONNECTION_TIMEOUT = 'ERR_CONNECTION_TIMEOUT'
const ERR_PREMATURE_CLOSE = 'ERR_PREMATURE_CLOSE'

/**
 * WebrtcPeerClient
 *
 * @param {Socket} socket Socket
 * @param {Object} options
 * @param {number} [options.connectionTimeout=10000] Определяет время ожидания для установления соединения.
 */
function WebrtcPeerClient(socket, options = {}) {
    if (!(this instanceof WebrtcPeerClient)) return new WebrtcPeerClient(socket)

    EventEmitter.call(this)

    const { connectionTimeout = 10 * 1000 } = options

    this.id = null
    this.socket = socket
    this._connectionTimeout = connectionTimeout

    this._peers = {}
    this._sessionQueues = {}
    this._timers = new Map()

    this.socket.on('webrtc-peer[discover]', this._onDiscover.bind(this))
    this.socket.on('webrtc-peer[message]', this._onMessage.bind(this))
    this.socket.on('webrtc-peer[offer]', this._onOffer.bind(this))
    this.socket.on('webrtc-peer[signal]', this._onSignal.bind(this))
    this.socket.on('webrtc-peer[reject]', this._onReject.bind(this))
}

WebrtcPeerClient.prototype._onDiscover = function(data) {
    this.id = data.id
    this.emit('discover', data.discoveryData);
}

WebrtcPeerClient.prototype._onMessage = function(data) {
    console.log('webrtcMessage:', data);

    this.emit('message', data);
}

WebrtcPeerClient.prototype._onOffer = function({ initiator, metadata, sessionId, signal }) {
    this._sessionQueues[sessionId] = [signal]

    const request = { initiator, metadata, sessionId }
    request.accept = this._accept.bind(this, request)
    request.reject = this._reject.bind(this, request)

    this.emit('request', request)
}

WebrtcPeerClient.prototype._accept = function(request, metadata = {}, peerOptions = {}) {
    peerOptions.initiator = false
    const peer = this._peers[request.sessionId] = new SimplePeer(peerOptions)

    peer.on('signal', (signal) => {
        this.socket.emit('webrtc-peer[signal]', {
            signal,
            metadata,
            sessionId: request.sessionId,
            target: request.initiator
        })
    })

    peer.once('close', () => {
        this._closePeer(request.sessionId)
    })

    // очистить очередь сигналов
    this._sessionQueues[request.sessionId].forEach(signal => {
        peer.signal(signal)
    })
    delete this._sessionQueues[request.sessionId]

    return new Promise((resolve, reject) => {
        this._onSafeConnect(peer, () => {
            this._clearTimer(request.sessionId)

            resolve({ peer, metadata: request.metadata })
        })

        peer.once('close', () => {
            reject({ metadata: { code: ERR_PREMATURE_CLOSE } })
        })

        this._startTimer(request.sessionId, metadata => {
            reject({ metadata })
            this._closePeer(request.sessionId)
        })
    })
}

WebrtcPeerClient.prototype._reject = function(request, metadata = {}) {
    // очистить очередь сигналов
    delete this._sessionQueues[request.sessionId]
    this._clearTimer(request.sessionId)
    this.socket.emit('webrtc-peer[reject]', {
        metadata,
        sessionId: request.sessionId,
        target: request.initiator
    })
}

WebrtcPeerClient.prototype._onReject = function({ sessionId, metadata }) {
    const peer = this._peers[sessionId]
    if (peer) peer.reject(metadata)
}

WebrtcPeerClient.prototype._onSignal = function({ sessionId, signal, metadata }) {
    const peer = this._peers[sessionId]
    if (peer) {
        peer.signal(signal)
        if (metadata !== undefined && peer.resolveMetadata) peer.resolveMetadata(metadata)
    } else {
        this._sessionQueues[sessionId] = this._sessionQueues[sessionId] || []
        this._sessionQueues[sessionId].push(signal)
    }
}

WebrtcPeerClient.prototype.connect = function(target, metadata = {}, peerOptions = {}) {
    if (!this.id) throw new Error('Сначала необходимо завершить первое.')

    peerOptions.initiator = true

    const sessionId = cuid() // TODO: надо бы заюзать что-то другое
    var firstOffer = true
    const peer = this._peers[sessionId] = new SimplePeer(peerOptions)

    peer.once('close', () => {
        this._closePeer(sessionId)
    })

    peer.on('signal', (signal) => {
        const messageType = signal.sdp && firstOffer ? 'webrtc-peer[offer]' : 'webrtc-peer[signal]'
        if (signal.sdp) firstOffer = false
        this.socket.emit(messageType, {
            signal,
            metadata,
            sessionId,
            target
        })
    })

    return new Promise((resolve, reject) => {
        peer.resolveMetadata = (metadata) => {
            peer.resolveMetadata = null
            this._onSafeConnect(peer, () => {
                this._clearTimer(sessionId)

                resolve({ peer, metadata })
            })
        }

        peer.reject = (metadata) => {
            reject({ metadata }) // eslint-disable-line
            this._closePeer(sessionId)
        }

        peer.once('close', () => {
            reject({ metadata: { code: ERR_PREMATURE_CLOSE } })
        })

        this._startTimer(sessionId, metadata => peer.reject(metadata))
    })
}

WebrtcPeerClient.prototype._onSafeConnect = function(peer, callback) {
    // webrtc-peer кэши транслируют и отслеживают события, чтобы они всегда появлялись ПОСЛЕ подключения
    const cachedEvents = []

    function streamHandler(stream) {
        cachedEvents.push({ name: 'stream', args: [stream] })
    }

    function trackHandler(track, stream) {
        cachedEvents.push({ name: 'track', args: [track, stream] })
    }
    peer.on('stream', streamHandler)
    peer.on('track', trackHandler)
    peer.once('connect', () => {
        setTimeout(() => {
            peer.emit('connect'); // выставить пропущенное событие "подключение" к приложению

            setTimeout(() => {
                cachedEvents.forEach(({ name, args }) => { // воспроизведение любых пропущенных событий потока/трека
                    peer.emit(name, ...args)
                })
            }, 0)
        }, 0)
        peer.removeListener('stream', streamHandler)
        peer.removeListener('track', trackHandler)
        callback(peer)
    })
}

WebrtcPeerClient.prototype._closePeer = function(sessionId) {
    const peer = this._peers[sessionId]
    this._clearTimer(sessionId)
    delete this._peers[sessionId]
    if (peer) peer.destroy()
}

WebrtcPeerClient.prototype._startTimer = function(sessionId, cb) {
    if (this._connectionTimeout !== -1) {
        const timer = setTimeout(() => {
            this._clearTimer(sessionId)
                // metadata err
            cb({ code: ERR_CONNECTION_TIMEOUT })
        }, this._connectionTimeout)
        this._timers.set(sessionId, timer)
    }
}

WebrtcPeerClient.prototype._clearTimer = function(sessionId) {
    if (this._timers.has(sessionId)) {
        clearTimeout(this._timers.get(sessionId))
        this._timers.delete(sessionId)
    }
}

WebrtcPeerClient.prototype.discover = function(discoveryData = {}) {
    this.socket.emit('webrtc-peer[discover]', discoveryData)
}

WebrtcPeerClient.prototype.peers = function() {
    console.log('webrtcPeers:', this._peers);

    return Object.values(this._peers)
}

WebrtcPeerClient.prototype.destroy = function() {
    this.socket.close()
    this.peers().forEach(peer => peer.destroy())

    this.id = null
    this.socket = null
    this._peers = null
    this._sessionQueues = null
}

module.exports = WebrtcPeerClient
module.exports.SimplePeer = SimplePeer
module.exports.ERR_CONNECTION_TIMEOUT = ERR_CONNECTION_TIMEOUT
module.exports.ERR_PREMATURE_CLOSE = ERR_PREMATURE_CLOSE