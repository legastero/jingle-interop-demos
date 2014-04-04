;(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var Jingle = require('jingle')
  , attachMediaStream = require('attachmediastream')

var socket = new Primus('https://xmpp-ftw.jit.su')
var jingle = new Jingle()

var loginInfo = document.getElementById('loginInfo')
var localStarted = false

loginInfo.onsubmit = function (e) {
  if (e.preventDefault) e.preventDefault()

  var jid = document.getElementById('jid').value
  var username = jid.slice(0, jid.indexOf('@'))

  console.log('Connected')
  socket.send(
    'xmpp.login', {
        jid: jid,
        password: document.getElementById('password').value,
        host: document.getElementById('host').value,
        resource: document.getElementById('resource').value || 'jingle-rocks'
    }
  )
  socket.on('xmpp.connection', function(data) {
    console.log('connected', data)
    socket.send('xmpp.presence', {})
    document.getElementById('myJID').textContent = data.jid.user +
        '@' + data.jid.domain + '/' + data.jid.resource
  })

  jingle.on('incoming', function (session) {
    console.log('incoming session', session)
    session.accept()
  })
  jingle.on('peerStreamAdded', function(session) {
    console.log('peerStreamAdded', session)
   attachMediaStream(session.stream, document.getElementById('remoteVideo'))
  })
  jingle.on('localStream', function (stream) {
    if (false === localStarted) {
      attachMediaStream(stream, document.getElementById('localVideo'), { muted: true, mirror: true })
      localStarted = true
    }
  })
  jingle.on('send', function(data) {
    if (data.jingle && (data.jingle.action == 'session-accept')) {
      console.debug('sending', data)
      window.jingleAccept = data
    }
    socket.send('xmpp.jingle.request', data, function(error, success) {
      if (error) return console.error('Failed', error)
      console.log(data.jingle.action + ' ack', success)
    })
  })

  var callInfo = document.getElementById('callInfo')
  callInfo.onsubmit = function (e) {
    e.preventDefault()
    var jid = document.getElementById('peer').value
    jingle.startLocalMedia(null, function (error, stream) {
      localStarted = true
      var sess = jingle.createMediaSession(jid)
      sess.start()
      console.log('Calling ' + jid)
    })
    return false
  }
  return false
}

socket.on('xmpp.error.client', function(error) {
  console.error(error)
})

jingle.startLocalMedia(null, function (error, stream) {
  if (error) return console.error(error)
  attachMediaStream(stream, document.getElementById('localVideo'), { muted: true, mirror: true })
  localStarted = true
})

socket.on('xmpp.jingle.request', function(data) {
  if (false === localStarted) {
    jingle.startLocalMedia(null, function (error, stream) {
      if (error) return console.error(error)
      attachMediaStream(stream, document.getElementById('localVideo'), { muted: true, mirror: true })
    })
    localStarted = true
  }
  jingle.process(data)
})

},{"attachmediastream":2,"jingle":4}],2:[function(require,module,exports){
module.exports = function (stream, el, options) {
    var URL = window.URL;
    var opts = {
        autoplay: true,
        mirror: false,
        muted: false
    };
    var element = el || document.createElement('video');
    var item;

    if (options) {
        for (item in options) {
            opts[item] = options[item];
        }
    }

    if (opts.autoplay) element.autoplay = 'autoplay';
    if (opts.muted) element.muted = true;
    if (opts.mirror) {
        ['', 'moz', 'webkit', 'o', 'ms'].forEach(function (prefix) {
            var styleName = prefix ? prefix + 'Transform' : 'transform';
            element.style[styleName] = 'scaleX(-1)';
        });
    }

    // this first one should work most everywhere now
    // but we have a few fallbacks just in case.
    if (URL && URL.createObjectURL) {
        element.src = URL.createObjectURL(stream);
    } else if (element.srcObject) {
        element.srcObject = stream;
    } else if (element.mozSrcObject) {
        element.mozSrcObject = stream;
    } else {
        return false;
    }

    return element;
};

},{}],3:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],4:[function(require,module,exports){
module.exports = require('./lib/sessionManager');

},{"./lib/sessionManager":7}],5:[function(require,module,exports){
var bows = require('bows');
var async = require('async');
var WildEmitter = require('wildemitter');
var JinglePeerConnection = require('jingle-rtcpeerconnection');
var JingleJSON = require('sdp-jingle-json');


var log = bows('JingleSession');


function actionToMethod(action) {
    var words = action.split('-');
    return 'on' + words[0][0].toUpperCase() + words[0].substr(1) + words[1][0].toUpperCase() + words[1].substr(1);
}


function JingleSession(opts) {
    var self = this;
    this.sid = opts.sid || Date.now().toString();
    this.peer = opts.peer;
    this.isInitiator = opts.initiator || false;
    this.state = 'starting';
    this.parent = opts.parent;

    this.processingQueue = async.queue(function (task, next) {
        var action  = task.action;
        var changes = task.changes;
        var cb = task.cb;

        log(self.sid + ': ' + action);
        self[action](changes, function (err) {
            cb(err);
            next();
        });
    });
}

JingleSession.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: JingleSession
    }
});


JingleSession.prototype.process = function (action, changes, cb) {
    var self = this;

    var method = actionToMethod(action);

    this.processingQueue.push({
        action: method,
        changes: changes,
        cb: cb
    });
};

JingleSession.prototype.send = function (type, data) {
    data = data || {};
    data.sid = this.sid;
    data.action = type;
    this.parent.emit('send', {
        to: this.peer,
        type: 'set',
        jingle: data
    });
};

Object.defineProperty(JingleSession.prototype, 'state', {
    get: function () {
        return this._state;
    },
    set: function (value) {
        var validStates = {
            starting: true,
            pending: true,
            active: true,
            ended: true
        };

        if (!validStates[value]) {
            throw new Error('Invalid Jingle Session State: ' + value);
        }

        if (this._state !== value) {
            this._state = value;
            log(this.sid + ': State changed to ' + value);
        }
    }
});
Object.defineProperty(JingleSession.prototype, 'starting', {
    get: function () {
        return this._state == 'starting';
    }
});
Object.defineProperty(JingleSession.prototype, 'pending', {
    get: function () {
        return this._state == 'pending';
    }
});
Object.defineProperty(JingleSession.prototype, 'active', {
    get: function () {
        return this._state == 'active';
    }
});
Object.defineProperty(JingleSession.prototype, 'ended', {
    get: function () {
        return this._state == 'ended';
    }
});

JingleSession.prototype.start = function () {
    this.state = 'pending';
    log(this.sid + ': Can not start generic session');
};
JingleSession.prototype.end = function (reason, silence) {
    this.parent.peers[this.peer].splice(this.parent.peers[this.peer].indexOf(this), 1);
    delete this.parent.sessions[this.sid];

    this.state = 'ended';

    reason = reason || {};

    if (!silence) {
        this.send('session-terminate', {reason: reason});
    }

    this.parent.emit('terminated', this, reason);
};

var actions = [
    'content-accept', 'content-add', 'content-modify',
    'conent-reject', 'content-remove', 'description-info',
    'session-accept', 'session-info', 'session-initiate',
    'session-terminate', 'transport-accept', 'transport-info',
    'transport-reject', 'transport-replace'
];

actions.forEach(function (action) {
    var method = actionToMethod(action);
    JingleSession.prototype[method] = function (changes, cb) {
        log(this.sid + ': Unsupported action ' + action);
        cb();
    };
});

module.exports = JingleSession;

},{"async":8,"bows":9,"jingle-rtcpeerconnection":13,"sdp-jingle-json":18,"wildemitter":24}],6:[function(require,module,exports){
var _ = require('underscore');
var bows = require('bows');
var JingleSession = require('./genericSession');
var JinglePeerConnection = require('jingle-rtcpeerconnection');


var log = bows('JingleMedia');


function MediaSession(opts) {
    JingleSession.call(this, opts);

    var self = this;

    this.pc = new JinglePeerConnection(this.parent.config.peerConnectionConfig,
                                       this.parent.config.peerConnectionConstraints);
    this.pc.on('ice', this.onIceCandidate.bind(this));
    this.pc.on('addStream', this.onStreamAdded.bind(this));
    this.pc.on('removeStream', this.onStreamRemoved.bind(this));
    this.pendingAnswer = null;

    if (this.parent.localStream) {
        this.pc.addStream(this.parent.localStream);
        this.localStream = this.parent.localStream;
    } else {
        this.parent.once('localStream', function (stream) {
            self.pc.addStream(stream);
            this.localStream = stream;
        });
    }

    this.stream = null;
}

MediaSession.prototype = Object.create(JingleSession.prototype, {
    constructor: {
        value: MediaSession
    }
});

MediaSession.prototype = _.extend(MediaSession.prototype, {
    start: function () {
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = true;
        this.pc.offer(function (err, sessDesc) {
            self.send('session-initiate', sessDesc.json);
        });
    },
    end: function (reason) {
        this.pc.close();
        this.onStreamRemoved();
        JingleSession.prototype.end.call(this, reason);
    },
    accept: function () {
        log(this.sid + ': Accepted incoming session');
        this.state = 'active';
        this.send('session-accept', this.pendingAnswer);
    },
    ring: function () {
        log(this.sid + ': Ringing on incoming session');
        this.send('session-info', {ringing: true});
    },
    mute: function (creator, name) {
        log(this.sid + ': Muting');
        this.send('session-info', {mute: {creator: creator, name: name}});
    },
    unmute: function (creator, name) {
        log(this.sid + ': Unmuting');
        this.send('session-info', {unmute: {creator: creator, name: name}});
    },
    hold: function () {
        log(this.sid + ': Placing on hold');
        this.send('session-info', {hold: true});
    },
    resume: function () {
        log(this.sid + ': Resuing from hold');
        this.send('session-info', {active: true});
    },
    onSessionInitiate: function (changes, cb) {
        log(this.sid + ': Initiating incoming session');
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = false;
        this.pc.answer({type: 'offer', json: changes}, function (err, answer) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return cb({condition: 'general-error'});
            }
            self.pendingAnswer = answer.json;
            cb();
        });
    },
    onSessionAccept: function (changes, cb) {
        var self = this;
        log(this.sid + ': Activating accepted outbound session');
        this.state = 'active';
        this.pc.handleAnswer({type: 'answer', json: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not process WebRTC answer', err);
                return cb({condition: 'general-error'});
            }

            self.parent.emit('accepted', self);
            cb();
        });
    },
    onSessionTerminate: function (changes, cb) {
        log(this.sid + ': Terminating session');
        this.pc.close();
        this.onStreamRemoved();
        JingleSession.prototype.end.call(this, changes.reason, true);
        cb();
    },
    onTransportInfo: function (changes, cb) {
        var self = this;
        log(this.sid + ': Adding ICE candidate');
        this.pc.processIce(changes, function (err) {
            if (err) {
                log(self.sid + ': Could not process ICE candidate', err);
            }
            cb();
        });
    },
    onSessionInfo: function (info, cb) {
        log(info);
        if (info.ringing) {
            log(this.sid + ': Ringing on remote stream');
            this.parent.emit('ringing', this);
        }

        if (info.hold) {
            log(this.sid + ': On hold');
            this.parent.emit('hold', this);
        }

        if (info.active) {
            log(this.sid + ': Resumed from hold');
            this.parent.emit('resumed', this);
        }

        if (info.mute) {
            log(this.sid + ': Muted', info.mute);
            this.parent.emit('mute', this, info.mute);
        }

        if (info.unmute) {
            log(this.sid + ': Unmuted', info.unmute);
            this.parent.emit('unmute', this, info.unmute);
        }

        cb();
    },
    onIceCandidate: function (candidateInfo) {
        log(this.sid + ': Discovered new ICE candidate', candidateInfo);
        this.send('transport-info', candidateInfo);
    },
    onStreamAdded: function (event) {
        if (this.stream) {
            log(this.sid + ': Received remote stream, but one already exists');
        } else {
            log(this.sid + ': Remote media stream added');
            this.stream = event.stream;
            this.parent.emit('peerStreamAdded', this);
        }
    },
    onStreamRemoved: function () {
        log(this.sid + ': Remote media stream removed');
        this.parent.emit('peerStreamRemoved', this);
    }
});


module.exports = MediaSession;

},{"./genericSession":5,"bows":9,"jingle-rtcpeerconnection":13,"underscore":22}],7:[function(require,module,exports){
var _ = require('underscore');
var bows = require('bows');
var hark = require('hark');
var webrtc = require('webrtcsupport');
var mockconsole = require('mockconsole');
var getUserMedia = require('getusermedia');
var JinglePeerConnection = require('jingle-rtcpeerconnection');
var WildEmitter = require('wildemitter');
var GainController = require('mediastream-gain');

var GenericSession = require('./genericSession');
var MediaSession = require('./mediaSession');


var log = bows('Jingle');


function Jingle(opts) {
    var self = this;
    opts = opts || {};
    var config = this.config = {
        debug: false,
        peerConnectionConfig: {
            iceServers: [{"url": "stun:stun.l.google.com:19302"}]
        },
        peerConnectionConstraints: {
            optional: [
                {DtlsSrtpKeyAgreement: true},
                {RtpDataChannels: false}
            ]
        },
        autoAdjustMic: false,
        media: {
            audio: true,
            video: true
        }
    };

    this.MediaSession = MediaSession;
    this.jid = opts.jid;
    this.sessions = {};
    this.peers = {};

    this.screenSharingSupport = webrtc.screenSharing;

    for (var item in opts) {
        config[item] = opts[item];
    }

    this.capabilities = [
        'urn:xmpp:jingle:1'
    ];
    if (webrtc.support) {
        this.capabilities = [
            'urn:xmpp:jingle:1',
            'urn:xmpp:jingle:apps:rtp:1',
            'urn:xmpp:jingle:apps:rtp:audio',
            'urn:xmpp:jingle:apps:rtp:video',
            'urn:xmpp:jingle:apps:rtp:rtcb-fb:0',
            'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0',
            'urn:xmpp:jingle:apps:dtls:0',
            'urn:xmpp:jingle:transports:ice-udp:1',
            'urn:ietf:rfc:3264'
        ];
    } else {
        log('WebRTC not supported');
    }

    WildEmitter.call(this);

    if (this.config.debug) {
        this.on('*', function (event, val1, val2) {
            log(event, val1, val2);
        });
    }
}

Jingle.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: Jingle
    }
});

Jingle.prototype.addICEServer = function (server) {
    this.config.peerConnectionConfig.iceServers.push(server);
};

Jingle.prototype.startLocalMedia = function (mediaConstraints, cb) {
    var self = this;
    var constraints = mediaConstraints || {video: true, audio: true};

    getUserMedia(constraints, function (err, stream) {
        if (!err) {
            if (constraints.audio && self.config.detectSpeakingEvents) {
                self.setupAudioMonitor(stream);
            }
            self.localStream = stream;

            if (self.config.autoAdjustMic) {
                self.gainController = new GainController(stream);
                self.setMicIfEnabled(0.5);
            }

            log('Local media stream started');
            self.emit('localStream', stream);
        } else {
            log('Could not start local media');
        }
        if (cb) cb(err, stream);
    });
};

Jingle.prototype.stopLocalMedia = function () {
    if (this.localStream) {
        this.localStream.stop();
        this.emit('localStreamStopped');
    }
};

Jingle.prototype.setupAudioMonitor = function (stream) {
    log('Setup audio');
    var audio = hark(stream);
    var self = this;
    var timeout;

    audio.on('speaking', function () {
        if (self.hardMuted) return;
        self.setMicIfEnabled(1);
        self.emit('speaking');
    });

    audio.on('stopped_speaking', function () {
        if (self.hardMuted) return;
        if (timeout) clearTimeout(timeout);

        timeout = setTimeout(function () {
            self.setMicIfEnabled(0.5);
            self.emit('stoppedSpeaking');
        }, 1000);
    });
};

Jingle.prototype.setMicIfEnabled = function (volume) {
    if (!this.config.autoAdjustMic) return;
    this.gainController.setGain(volume);
};

Jingle.prototype.sendError = function (to, id, data) {
    data.type = 'cancel';
    this.emit('send', {
        to: to,
        id: id,
        type: 'error',
        error: data
    });
};

Jingle.prototype.process = function (req) {
    var self = this;

    if (req.type === 'error') {
        return this.emit('error', req);
    }

    if (req.type === 'result') {
        return;
    }

    var sids, currsid, sess;
    var sid = req.jingle.sid;
    var action = req.jingle.action;
    var contents = req.jingle.contents || [];
    var contentTypes = _.map(contents, function (content) {
        return (content.description || {}).descType;
    });

    var session = this.sessions[sid] || null;

    var sender = req.from.full || req.from;
    var reqid = req.id;

    if (action !== 'session-initiate') {
        // Can't modify a session that we don't have.
        if (!session) {
            log('Unknown session', sid);
            return this.sendError(sender, reqid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Check if someone is trying to hijack a session.
        if (session.peer !== sender || session.ended) {
            log('Session has ended, or action has wrong sender');
            return this.sendError(sender, reqid, {
                condition: 'item-not-found',
                jingleCondition: 'unknown-session'
            });
        }

        // Can't accept a session twice
        if (action === 'session-accept' && !session.pending) {
            log('Tried to accept session twice', sid);
            return this.sendError(sender, reqid, {
                condition: 'unexpected-request',
                jingleCondition: 'out-of-order'
            });
        }

        // Can't process two requests at once, need to tie break
        if (action !== 'session-terminate' && session.pendingAction) {
            log('Tie break during pending request');
            if (session.isInitiator) {
                return this.sendError(sender, reqid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }
    } else if (session) {
        // Don't accept a new session if we already have one.
        if (session.peer !== sender) {
            log('Duplicate sid from new sender');
            return this.sendError(sender, reqid, {
                condition: 'service-unavailable'
            });
        }

        // Check if we need to have a tie breaker because both parties
        // happened to pick the same random sid.
        if (session.pending) {
            if (this.jid > session.peer) {
                log('Tie break new session because of duplicate sids');
                return this.sendError(sender, reqid, {
                    condition: 'conflict',
                    jingleCondition: 'tie-break'
                });
            }
        }

        // The other side is just doing it wrong.
        log('Someone is doing this wrong');
        return this.sendError(sender, reqid, {
            condition: 'unexpected-request',
            jingleCondition: 'out-of-order'
        });
    } else if (Object.keys(this.peers[sender] || {}).length) {
        // Check if we need to have a tie breaker because we already have 
        // a different session that is using the requested content types.
        sids = Object.keys(this.peers[sender]);
        for (var i = 0; i < sids.length; i++) {
            currsid = sids[i];
            sess = this.sessions[currsid];
            if (sess.pending) {
                if (_.intersection(contentTypes, sess.contentTypes).length) {
                    // We already have a pending session request for this content type.
                    if (currsid > sid) {
                        // We won the tie breaker
                        log('Tie break');
                        return this.sendError(sender, reqid, {
                            condition: 'conflict',
                            jingleCondition: 'tie-break'
                        });
                    }
                }
            }
        }
    }

    if (action === 'session-initiate') {
        var opts = {
            sid: sid,
            peer: sender,
            initiator: false,
            parent: this
        };
        if (contentTypes.indexOf('rtp') >= 0) {
            session = new MediaSession(opts);
        } else {
            session = new GenericSession(opts);
        }

        this.sessions[sid] = session;
        if (!this.peers[sender]) {
            this.peers[sender] = [];
        }
        this.peers[sender].push(session);
    }

    session.process(action, req.jingle, function (err) {
        if (err) {
            log('Could not process request', req, err);
            self.sendError(sender, reqid, err);
        } else {
            self.emit(
                'send',
                { to: sender, id: reqid, type: 'result', action: action }
            );
            if (action === 'session-initiate') {
                log('Incoming session request from ', sender, session);
                self.emit('incoming', session);
            }
        }
    });
};

Jingle.prototype.createMediaSession = function (peer, sid) {
    var session = new MediaSession({
        sid: sid,
        peer: peer,
        initiator: true,
        parent: this
    });

    sid = session.sid;

    this.sessions[sid] = session;
    if (!this.peers[peer]) {
        this.peers[peer] = [];
    }
    this.peers[peer].push(session);

    log('Outgoing session', session.sid, session);
    this.emit('outgoing', session);
    return session;
};

Jingle.prototype.endPeerSessions = function (peer) {
    log('Ending all sessions with', peer);
    var sessions = this.peers[peer] || [];
    sessions.forEach(function (session) {
        session.end();
    });
};


module.exports = Jingle;

},{"./genericSession":5,"./mediaSession":6,"bows":9,"getusermedia":11,"hark":12,"jingle-rtcpeerconnection":13,"mediastream-gain":15,"mockconsole":17,"underscore":22,"webrtcsupport":23,"wildemitter":24}],8:[function(require,module,exports){
var process=require("__browserify_process");/*global setImmediate: false, setTimeout: false, console: false */
(function () {

    var async = {};

    // global on the server, window in the browser
    var root, previous_async;

    root = this;
    if (root != null) {
      previous_async = root.async;
    }

    async.noConflict = function () {
        root.async = previous_async;
        return async;
    };

    function only_once(fn) {
        var called = false;
        return function() {
            if (called) throw new Error("Callback was already called.");
            called = true;
            fn.apply(root, arguments);
        }
    }

    //// cross-browser compatiblity functions ////

    var _each = function (arr, iterator) {
        if (arr.forEach) {
            return arr.forEach(iterator);
        }
        for (var i = 0; i < arr.length; i += 1) {
            iterator(arr[i], i, arr);
        }
    };

    var _map = function (arr, iterator) {
        if (arr.map) {
            return arr.map(iterator);
        }
        var results = [];
        _each(arr, function (x, i, a) {
            results.push(iterator(x, i, a));
        });
        return results;
    };

    var _reduce = function (arr, iterator, memo) {
        if (arr.reduce) {
            return arr.reduce(iterator, memo);
        }
        _each(arr, function (x, i, a) {
            memo = iterator(memo, x, i, a);
        });
        return memo;
    };

    var _keys = function (obj) {
        if (Object.keys) {
            return Object.keys(obj);
        }
        var keys = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                keys.push(k);
            }
        }
        return keys;
    };

    //// exported async module functions ////

    //// nextTick implementation with browser-compatible fallback ////
    if (typeof process === 'undefined' || !(process.nextTick)) {
        if (typeof setImmediate === 'function') {
            async.nextTick = function (fn) {
                // not a direct alias for IE10 compatibility
                setImmediate(fn);
            };
            async.setImmediate = async.nextTick;
        }
        else {
            async.nextTick = function (fn) {
                setTimeout(fn, 0);
            };
            async.setImmediate = async.nextTick;
        }
    }
    else {
        async.nextTick = process.nextTick;
        if (typeof setImmediate !== 'undefined') {
            async.setImmediate = setImmediate;
        }
        else {
            async.setImmediate = async.nextTick;
        }
    }

    async.each = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        _each(arr, function (x) {
            iterator(x, only_once(function (err) {
                if (err) {
                    callback(err);
                    callback = function () {};
                }
                else {
                    completed += 1;
                    if (completed >= arr.length) {
                        callback(null);
                    }
                }
            }));
        });
    };
    async.forEach = async.each;

    async.eachSeries = function (arr, iterator, callback) {
        callback = callback || function () {};
        if (!arr.length) {
            return callback();
        }
        var completed = 0;
        var iterate = function () {
            iterator(arr[completed], function (err) {
                if (err) {
                    callback(err);
                    callback = function () {};
                }
                else {
                    completed += 1;
                    if (completed >= arr.length) {
                        callback(null);
                    }
                    else {
                        iterate();
                    }
                }
            });
        };
        iterate();
    };
    async.forEachSeries = async.eachSeries;

    async.eachLimit = function (arr, limit, iterator, callback) {
        var fn = _eachLimit(limit);
        fn.apply(null, [arr, iterator, callback]);
    };
    async.forEachLimit = async.eachLimit;

    var _eachLimit = function (limit) {

        return function (arr, iterator, callback) {
            callback = callback || function () {};
            if (!arr.length || limit <= 0) {
                return callback();
            }
            var completed = 0;
            var started = 0;
            var running = 0;

            (function replenish () {
                if (completed >= arr.length) {
                    return callback();
                }

                while (running < limit && started < arr.length) {
                    started += 1;
                    running += 1;
                    iterator(arr[started - 1], function (err) {
                        if (err) {
                            callback(err);
                            callback = function () {};
                        }
                        else {
                            completed += 1;
                            running -= 1;
                            if (completed >= arr.length) {
                                callback();
                            }
                            else {
                                replenish();
                            }
                        }
                    });
                }
            })();
        };
    };


    var doParallel = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.each].concat(args));
        };
    };
    var doParallelLimit = function(limit, fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [_eachLimit(limit)].concat(args));
        };
    };
    var doSeries = function (fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return fn.apply(null, [async.eachSeries].concat(args));
        };
    };


    var _asyncMap = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (err, v) {
                results[x.index] = v;
                callback(err);
            });
        }, function (err) {
            callback(err, results);
        });
    };
    async.map = doParallel(_asyncMap);
    async.mapSeries = doSeries(_asyncMap);
    async.mapLimit = function (arr, limit, iterator, callback) {
        return _mapLimit(limit)(arr, iterator, callback);
    };

    var _mapLimit = function(limit) {
        return doParallelLimit(limit, _asyncMap);
    };

    // reduce only has a series version, as doing reduce in parallel won't
    // work in many situations.
    async.reduce = function (arr, memo, iterator, callback) {
        async.eachSeries(arr, function (x, callback) {
            iterator(memo, x, function (err, v) {
                memo = v;
                callback(err);
            });
        }, function (err) {
            callback(err, memo);
        });
    };
    // inject alias
    async.inject = async.reduce;
    // foldl alias
    async.foldl = async.reduce;

    async.reduceRight = function (arr, memo, iterator, callback) {
        var reversed = _map(arr, function (x) {
            return x;
        }).reverse();
        async.reduce(reversed, memo, iterator, callback);
    };
    // foldr alias
    async.foldr = async.reduceRight;

    var _filter = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.filter = doParallel(_filter);
    async.filterSeries = doSeries(_filter);
    // select alias
    async.select = async.filter;
    async.selectSeries = async.filterSeries;

    var _reject = function (eachfn, arr, iterator, callback) {
        var results = [];
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        eachfn(arr, function (x, callback) {
            iterator(x.value, function (v) {
                if (!v) {
                    results.push(x);
                }
                callback();
            });
        }, function (err) {
            callback(_map(results.sort(function (a, b) {
                return a.index - b.index;
            }), function (x) {
                return x.value;
            }));
        });
    };
    async.reject = doParallel(_reject);
    async.rejectSeries = doSeries(_reject);

    var _detect = function (eachfn, arr, iterator, main_callback) {
        eachfn(arr, function (x, callback) {
            iterator(x, function (result) {
                if (result) {
                    main_callback(x);
                    main_callback = function () {};
                }
                else {
                    callback();
                }
            });
        }, function (err) {
            main_callback();
        });
    };
    async.detect = doParallel(_detect);
    async.detectSeries = doSeries(_detect);

    async.some = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (v) {
                    main_callback(true);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(false);
        });
    };
    // any alias
    async.any = async.some;

    async.every = function (arr, iterator, main_callback) {
        async.each(arr, function (x, callback) {
            iterator(x, function (v) {
                if (!v) {
                    main_callback(false);
                    main_callback = function () {};
                }
                callback();
            });
        }, function (err) {
            main_callback(true);
        });
    };
    // all alias
    async.all = async.every;

    async.sortBy = function (arr, iterator, callback) {
        async.map(arr, function (x, callback) {
            iterator(x, function (err, criteria) {
                if (err) {
                    callback(err);
                }
                else {
                    callback(null, {value: x, criteria: criteria});
                }
            });
        }, function (err, results) {
            if (err) {
                return callback(err);
            }
            else {
                var fn = function (left, right) {
                    var a = left.criteria, b = right.criteria;
                    return a < b ? -1 : a > b ? 1 : 0;
                };
                callback(null, _map(results.sort(fn), function (x) {
                    return x.value;
                }));
            }
        });
    };

    async.auto = function (tasks, callback) {
        callback = callback || function () {};
        var keys = _keys(tasks);
        if (!keys.length) {
            return callback(null);
        }

        var results = {};

        var listeners = [];
        var addListener = function (fn) {
            listeners.unshift(fn);
        };
        var removeListener = function (fn) {
            for (var i = 0; i < listeners.length; i += 1) {
                if (listeners[i] === fn) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        };
        var taskComplete = function () {
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (_keys(results).length === keys.length) {
                callback(null, results);
                callback = function () {};
            }
        });

        _each(keys, function (k) {
            var task = (tasks[k] instanceof Function) ? [tasks[k]]: tasks[k];
            var taskCallback = function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (args.length <= 1) {
                    args = args[0];
                }
                if (err) {
                    var safeResults = {};
                    _each(_keys(results), function(rkey) {
                        safeResults[rkey] = results[rkey];
                    });
                    safeResults[k] = args;
                    callback(err, safeResults);
                    // stop subsequent errors hitting callback multiple times
                    callback = function () {};
                }
                else {
                    results[k] = args;
                    async.setImmediate(taskComplete);
                }
            };
            var requires = task.slice(0, Math.abs(task.length - 1)) || [];
            var ready = function () {
                return _reduce(requires, function (a, x) {
                    return (a && results.hasOwnProperty(x));
                }, true) && !results.hasOwnProperty(k);
            };
            if (ready()) {
                task[task.length - 1](taskCallback, results);
            }
            else {
                var listener = function () {
                    if (ready()) {
                        removeListener(listener);
                        task[task.length - 1](taskCallback, results);
                    }
                };
                addListener(listener);
            }
        });
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (tasks.constructor !== Array) {
          var err = new Error('First argument to waterfall must be an array of functions');
          return callback(err);
        }
        if (!tasks.length) {
            return callback();
        }
        var wrapIterator = function (iterator) {
            return function (err) {
                if (err) {
                    callback.apply(null, arguments);
                    callback = function () {};
                }
                else {
                    var args = Array.prototype.slice.call(arguments, 1);
                    var next = iterator.next();
                    if (next) {
                        args.push(wrapIterator(next));
                    }
                    else {
                        args.push(callback);
                    }
                    async.setImmediate(function () {
                        iterator.apply(null, args);
                    });
                }
            };
        };
        wrapIterator(async.iterator(tasks))();
    };

    var _parallel = function(eachfn, tasks, callback) {
        callback = callback || function () {};
        if (tasks.constructor === Array) {
            eachfn.map(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            eachfn.each(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.parallel = function (tasks, callback) {
        _parallel({ map: async.map, each: async.each }, tasks, callback);
    };

    async.parallelLimit = function(tasks, limit, callback) {
        _parallel({ map: _mapLimit(limit), each: _eachLimit(limit) }, tasks, callback);
    };

    async.series = function (tasks, callback) {
        callback = callback || function () {};
        if (tasks.constructor === Array) {
            async.mapSeries(tasks, function (fn, callback) {
                if (fn) {
                    fn(function (err) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        if (args.length <= 1) {
                            args = args[0];
                        }
                        callback.call(null, err, args);
                    });
                }
            }, callback);
        }
        else {
            var results = {};
            async.eachSeries(_keys(tasks), function (k, callback) {
                tasks[k](function (err) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (args.length <= 1) {
                        args = args[0];
                    }
                    results[k] = args;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
    };

    async.iterator = function (tasks) {
        var makeCallback = function (index) {
            var fn = function () {
                if (tasks.length) {
                    tasks[index].apply(null, arguments);
                }
                return fn.next();
            };
            fn.next = function () {
                return (index < tasks.length - 1) ? makeCallback(index + 1): null;
            };
            return fn;
        };
        return makeCallback(0);
    };

    async.apply = function (fn) {
        var args = Array.prototype.slice.call(arguments, 1);
        return function () {
            return fn.apply(
                null, args.concat(Array.prototype.slice.call(arguments))
            );
        };
    };

    var _concat = function (eachfn, arr, fn, callback) {
        var r = [];
        eachfn(arr, function (x, cb) {
            fn(x, function (err, y) {
                r = r.concat(y || []);
                cb(err);
            });
        }, function (err) {
            callback(err, r);
        });
    };
    async.concat = doParallel(_concat);
    async.concatSeries = doSeries(_concat);

    async.whilst = function (test, iterator, callback) {
        if (test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.whilst(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doWhilst = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            if (test()) {
                async.doWhilst(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.until = function (test, iterator, callback) {
        if (!test()) {
            iterator(function (err) {
                if (err) {
                    return callback(err);
                }
                async.until(test, iterator, callback);
            });
        }
        else {
            callback();
        }
    };

    async.doUntil = function (iterator, test, callback) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            if (!test()) {
                async.doUntil(iterator, test, callback);
            }
            else {
                callback();
            }
        });
    };

    async.queue = function (worker, concurrency) {
        if (concurrency === undefined) {
            concurrency = 1;
        }
        function _insert(q, data, pos, callback) {
          if(data.constructor !== Array) {
              data = [data];
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  callback: typeof callback === 'function' ? callback : null
              };

              if (pos) {
                q.tasks.unshift(item);
              } else {
                q.tasks.push(item);
              }

              if (q.saturated && q.tasks.length === concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }

        var workers = 0;
        var q = {
            tasks: [],
            concurrency: concurrency,
            saturated: null,
            empty: null,
            drain: null,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (workers < q.concurrency && q.tasks.length) {
                    var task = q.tasks.shift();
                    if (q.empty && q.tasks.length === 0) {
                        q.empty();
                    }
                    workers += 1;
                    var next = function () {
                        workers -= 1;
                        if (task.callback) {
                            task.callback.apply(task, arguments);
                        }
                        if (q.drain && q.tasks.length + workers === 0) {
                            q.drain();
                        }
                        q.process();
                    };
                    var cb = only_once(next);
                    worker(task.data, cb);
                }
            },
            length: function () {
                return q.tasks.length;
            },
            running: function () {
                return workers;
            }
        };
        return q;
    };

    async.cargo = function (worker, payload) {
        var working     = false,
            tasks       = [];

        var cargo = {
            tasks: tasks,
            payload: payload,
            saturated: null,
            empty: null,
            drain: null,
            push: function (data, callback) {
                if(data.constructor !== Array) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain) cargo.drain();
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0);

                var ds = _map(ts, function (task) {
                    return task.data;
                });

                if(cargo.empty) cargo.empty();
                working = true;
                worker(ds, function () {
                    working = false;

                    var args = arguments;
                    _each(ts, function (data) {
                        if (data.callback) {
                            data.callback.apply(null, args);
                        }
                    });

                    process();
                });
            },
            length: function () {
                return tasks.length;
            },
            running: function () {
                return working;
            }
        };
        return cargo;
    };

    var _console_fn = function (name) {
        return function (fn) {
            var args = Array.prototype.slice.call(arguments, 1);
            fn.apply(null, args.concat([function (err) {
                var args = Array.prototype.slice.call(arguments, 1);
                if (typeof console !== 'undefined') {
                    if (err) {
                        if (console.error) {
                            console.error(err);
                        }
                    }
                    else if (console[name]) {
                        _each(args, function (x) {
                            console[name](x);
                        });
                    }
                }
            }]));
        };
    };
    async.log = _console_fn('log');
    async.dir = _console_fn('dir');
    /*async.info = _console_fn('info');
    async.warn = _console_fn('warn');
    async.error = _console_fn('error');*/

    async.memoize = function (fn, hasher) {
        var memo = {};
        var queues = {};
        hasher = hasher || function (x) {
            return x;
        };
        var memoized = function () {
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            var key = hasher.apply(null, args);
            if (key in memo) {
                callback.apply(null, memo[key]);
            }
            else if (key in queues) {
                queues[key].push(callback);
            }
            else {
                queues[key] = [callback];
                fn.apply(null, args.concat([function () {
                    memo[key] = arguments;
                    var q = queues[key];
                    delete queues[key];
                    for (var i = 0, l = q.length; i < l; i++) {
                      q[i].apply(null, arguments);
                    }
                }]));
            }
        };
        memoized.memo = memo;
        memoized.unmemoized = fn;
        return memoized;
    };

    async.unmemoize = function (fn) {
      return function () {
        return (fn.unmemoized || fn).apply(null, arguments);
      };
    };

    async.times = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.map(counter, iterator, callback);
    };

    async.timesSeries = function (count, iterator, callback) {
        var counter = [];
        for (var i = 0; i < count; i++) {
            counter.push(i);
        }
        return async.mapSeries(counter, iterator, callback);
    };

    async.compose = function (/* functions... */) {
        var fns = Array.prototype.reverse.call(arguments);
        return function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            async.reduce(fns, args, function (newargs, fn, cb) {
                fn.apply(that, newargs.concat([function () {
                    var err = arguments[0];
                    var nextargs = Array.prototype.slice.call(arguments, 1);
                    cb(err, nextargs);
                }]))
            },
            function (err, results) {
                callback.apply(that, [err].concat(results));
            });
        };
    };

    var _applyEach = function (eachfn, fns /*args...*/) {
        var go = function () {
            var that = this;
            var args = Array.prototype.slice.call(arguments);
            var callback = args.pop();
            return eachfn(fns, function (fn, cb) {
                fn.apply(that, args.concat([cb]));
            },
            callback);
        };
        if (arguments.length > 2) {
            var args = Array.prototype.slice.call(arguments, 2);
            return go.apply(this, args);
        }
        else {
            return go;
        }
    };
    async.applyEach = doParallel(_applyEach);
    async.applyEachSeries = doSeries(_applyEach);

    async.forever = function (fn, callback) {
        function next(err) {
            if (err) {
                if (callback) {
                    return callback(err);
                }
                throw err;
            }
            fn(next);
        }
        next();
    };

    // AMD / RequireJS
    if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // Node.js
    else if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

},{"__browserify_process":3}],9:[function(require,module,exports){
(function() {
  var inNode = typeof window === 'undefined',
      ls = !inNode && window.localStorage,
      debug = ls.debug,
      logger = require('andlog'),
      goldenRatio = 0.618033988749895,
      hue = 0,
      padLength = 15,
      noop = function() {},
      yieldColor,
      bows,
      debugRegex;

  yieldColor = function() {
    hue += goldenRatio;
    hue = hue % 1;
    return hue * 360;
  };

  var debugRegex = debug && debug[0]==='/' && new RegExp(debug.substring(1,debug.length-1));

  bows = function(str) {
    var msg;
    msg = "%c" + (str.slice(0, padLength));
    msg += Array(padLength + 3 - msg.length).join(' ') + '|';

    if (debugRegex && !str.match(debugRegex)) return noop;
    if (!window.chrome) return logger.log.bind(logger, msg);
    return logger.log.bind(logger, msg, "color: hsl(" + (yieldColor()) + ",99%,40%); font-weight: bold");
  };

  bows.config = function(config) {
    if (config.padLength) {
      return padLength = config.padLength;
    }
  };

  if (typeof module !== 'undefined') {
    module.exports = bows;
  } else {
    window.bows = bows;
  }
}).call();

},{"andlog":10}],10:[function(require,module,exports){
// follow @HenrikJoreteg and @andyet if you like this ;)
(function () {
    var inNode = typeof window === 'undefined',
        ls = !inNode && window.localStorage,
        out = {};

    if (inNode) {
        module.exports = console;
        return;
    }

    if (ls && ls.debug && window.console) {
        out = window.console;
    } else {
        var methods = "assert,count,debug,dir,dirxml,error,exception,group,groupCollapsed,groupEnd,info,log,markTimeline,profile,profileEnd,time,timeEnd,trace,warn".split(","),
            l = methods.length,
            fn = function () {};

        while (l--) {
            out[methods[l]] = fn;
        }
    }
    if (typeof exports !== 'undefined') {
        module.exports = out;
    } else {
        window.console = out;
    }
})();

},{}],11:[function(require,module,exports){
// getUserMedia helper by @HenrikJoreteg
var func = (navigator.getUserMedia ||
            navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia ||
            navigator.msGetUserMedia);


module.exports = function (constraints, cb) {
    var options;
    var haveOpts = arguments.length === 2;
    var defaultOpts = {video: true, audio: true};
    var error;
    var denied = 'PERMISSION_DENIED';
    var notSatified = 'CONSTRAINT_NOT_SATISFIED';

    // make constraints optional
    if (!haveOpts) {
        cb = constraints;
        constraints = defaultOpts;
    }

    // treat lack of browser support like an error
    if (!func) {
        // throw proper error per spec
        error = new Error('NavigatorUserMediaError');
        error.name = 'NOT_SUPPORTED_ERROR';
        return cb(error);
    }

    func.call(navigator, constraints, function (stream) {
        cb(null, stream);
    }, function (err) {
        var error;
        // coerce into an error object since FF gives us a string
        // there are only two valid names according to the spec
        // we coerce all non-denied to "constraint not satisfied".
        if (typeof err === 'string') {
            error = new Error('NavigatorUserMediaError');
            if (err === denied) {
                error.name = denied;
            } else {
                error.name = notSatified;
            }
        } else {
            // if we get an error object make sure '.name' property is set
            // according to spec: http://dev.w3.org/2011/webrtc/editor/getusermedia.html#navigatorusermediaerror-and-navigatorusermediaerrorcallback
            error = err;
            if (!error.name) {
                // this is likely chrome which
                // sets a property called "ERROR_DENIED" on the error object
                // if so we make sure to set a name
                if (error[denied]) {
                    err.name = denied;
                } else {
                    err.name = notSatified;
                }
            }
        }

        cb(error);
    });
};

},{}],12:[function(require,module,exports){
var WildEmitter = require('wildemitter');

function getMaxVolume (analyser, fftBins) {
  var maxVolume = -Infinity;
  analyser.getFloatFrequencyData(fftBins);

  for(var i=0, ii=fftBins.length; i < ii; i++) {
    if (fftBins[i] > maxVolume && fftBins[i] < 0) {
      maxVolume = fftBins[i];
    }
  };

  return maxVolume;
}


module.exports = function(stream, options) {
  var harker = new WildEmitter();

  // make it not break in non-supported browsers
  if (!window.webkitAudioContext) return harker;

  //Config
  var options = options || {},
      smoothing = (options.smoothing || 0.5),
      interval = (options.interval || 100),
      threshold = options.threshold,
      play = options.play;

  //Setup Audio Context
  var audioContext = new webkitAudioContext();
  var sourceNode, fftBins, analyser;

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = smoothing;
  fftBins = new Float32Array(analyser.fftSize);

  if (stream.jquery) stream = stream[0];
  if (stream instanceof HTMLAudioElement) {
    //Audio Tag
    sourceNode = audioContext.createMediaElementSource(stream);
    if (typeof play === 'undefined') play = true;
    threshold = threshold || -65;
  } else {
    //WebRTC Stream
    sourceNode = audioContext.createMediaStreamSource(stream);
    threshold = threshold || -45;
  }

  sourceNode.connect(analyser);
  if (play) analyser.connect(audioContext.destination);

  harker.speaking = false;

  harker.setThreshold = function(t) {
    threshold = t;
  };

  harker.setInterval = function(i) {
    interval = i;
  };

  // Poll the analyser node to determine if speaking
  // and emit events if changed
  var looper = function() {
    setTimeout(function() {
      var currentVolume = getMaxVolume(analyser, fftBins);

      harker.emit('volume_change', currentVolume, threshold);

      if (currentVolume > threshold) {
        if (!harker.speaking) {
          harker.speaking = true;
          harker.emit('speaking');
        }
      } else {
        if (harker.speaking) {
          harker.speaking = false;
          harker.emit('stopped_speaking');
        }
      }

      looper();
    }, interval);
  };
  looper();


  return harker;
}

},{"wildemitter":24}],13:[function(require,module,exports){
var _ = require('underscore');
var webrtc = require('webrtcsupport');
var PeerConnection = require('rtcpeerconnection');
var SJJ = require('sdp-jingle-json');


function JinglePeerConnection(config, constraints) {
    this.sid = '';
    this.sdpSessId = Date.now();
    this.isInitiator = true;

    this.localDescription = {contents: []};
    this.remoteDescription = {contents: []};

    this.iceConfigs = {};

    PeerConnection.call(this, config, constraints);
}

JinglePeerConnection.prototype = Object.create(PeerConnection.prototype, {
    constructor: {
        value: JinglePeerConnection
    }
});


// Generate and emit an offer with the given constraints
JinglePeerConnection.prototype.offer = function (constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 2;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };
    var callback = hasConstraints ? cb : constraints;

    // Actually generate the offer
    this.pc.createOffer(
        function (offer) {
            offer.sdp = self._applySdpHack(offer.sdp);
            self.pc.setLocalDescription(offer);
            var json = SJJ.toSessionJSON(offer.sdp, self.isInitiator ? 'initiator' : 'responder');
            json.sid = this.sid;
            self.localDescription = json;

            // Save ICE credentials
            _.each(json.contents, function (content) {
                if ((content.transport || {}).ufrag) {
                    self.iceConfigs[content.name] = {
                        ufrag: (content.transport || {}).ufrag,
                        pwd: (content.transport || {}).pwd
                    };
                }
            });

            var expandedOffer = {
                type: 'offer',
                sdp: offer.sdp,
                json: json
            };
            self.emit('offer', expandedOffer);
            if (callback) callback(null, expandedOffer);
        },
        function (err) {
            self.emit('error', err);
            if (callback) callback(err);
        },
        mediaConstraints
    );
};


// Process an answer
PeerConnection.prototype.handleAnswer = function (answer, cb) {
    cb = cb || function () {};
    var self = this;
    answer.sdp = SJJ.toSessionSDP(answer.json, this.sdpSessId);
    self.remoteDescription = answer.json;
    this.pc.setRemoteDescription(
        new webrtc.SessionDescription(answer),
        function () {
            cb(null);
        },
        function (err) {
            cb(err);
        }
    );
};

// Internal code sharing for various types of answer methods
JinglePeerConnection.prototype._answer = function (offer, constraints, cb) {
    cb = cb || function () {};
    var self = this;
    offer.sdp = SJJ.toSessionSDP(offer.json, self.sdpSessId);
    self.remoteDescription = offer.json;
    this.pc.setRemoteDescription(new webrtc.SessionDescription(offer), function () {
        self.pc.createAnswer(
            function (answer) {
                answer.sdp = self._applySdpHack(answer.sdp);
                self.pc.setLocalDescription(answer);
                var json = SJJ.toSessionJSON(answer.sdp);
                json.sid = self.sid;
                self.localDescription = json;
                var expandedAnswer = {
                    type: 'answer',
                    sdp: answer.sdp,
                    json: json
                };
                self.emit('answer', expandedAnswer);
                if (cb) cb(null, expandedAnswer);
            }, function (err) {
                self.emit('error', err);
                if (cb) cb(err);
            },
            constraints
        );
    }, function (err) {
        cb(err);
    });
};


// Init and add ice candidate object with correct constructor
JinglePeerConnection.prototype.processIce = function (update, cb) {
    cb = cb || function () {};

    var self = this;

    var contentNames = _.map(this.remoteDescription.contents, function (content) {
        return content.name;
    });

    var contents = update.contents || [];
    contents.forEach(function (content) {
        var transport = content.transport || {};
        var candidates = transport.candidates || [];

        var mline = contentNames.indexOf(content.name);
        var mid = content.name;

        candidates.forEach(function (candidate) {
            var iceCandidate = SJJ.toCandidateSDP(candidate) + '\r\n';
            var iceData = {
                candidate: iceCandidate,
                sdpMLineIndex: mline,
                sdpMid: mid
            };
            self.pc.addIceCandidate(new webrtc.IceCandidate(iceData));
        });
    });
    cb();
};


// Internal method for emitting ice candidates on our peer object
JinglePeerConnection.prototype._onIce = function (event) {
    var self = this;
    if (event.candidate) {
        var ice = event.candidate;

        if (!self.iceConfigs[ice.sdpMid]) {
            // Save ICE credentials
            var json = SJJ.toSessionJSON(self.pc.localDescription.sdp, self.isInitiator ? 'initiator' : 'responder');
            _.each(json.contents, function (content) {
                if ((content.transport || {}).ufrag) {
                    self.iceConfigs[content.name] = {
                        ufrag: (content.transport || {}).ufrag,
                        pwd: (content.transport || {}).pwd
                    };
                }
            });
        }

        this.emit('ice', {
            contents: [{
                name: ice.sdpMid,
                creator: self.isInitiator ? 'initiator' : 'responder',
                transport: {
                    transType: 'iceUdp',
                    ufrag: self.iceConfigs[ice.sdpMid].ufrag,
                    pwd: self.iceConfigs[ice.sdpMid].pwd,
                    candidates: [
                        SJJ.toCandidateJSON(ice.candidate)
                    ]
                }
            }]
        });
    } else {
        this.emit('endOfCandidates');
    }
};


module.exports = JinglePeerConnection;

},{"rtcpeerconnection":14,"sdp-jingle-json":18,"underscore":22,"webrtcsupport":23}],14:[function(require,module,exports){
var WildEmitter = require('wildemitter');
var webrtc = require('webrtcsupport');


function PeerConnection(config, constraints) {
    var item;
    this.pc = new webrtc.PeerConnection(config, constraints);
    WildEmitter.call(this);

    // proxy some events directly
    this.pc.onremovestream = this.emit.bind(this, 'removeStream');
    this.pc.onnegotiationneeded = this.emit.bind(this, 'negotiationNeeded');
    this.pc.oniceconnectionstatechange = this.emit.bind(this, 'iceConnectionStateChange');
    this.pc.onsignalingstatechange = this.emit.bind(this, 'signalingStateChange');

    // handle incoming ice and data channel events
    this.pc.onaddstream = this._onAddStream.bind(this);
    this.pc.onicecandidate = this._onIce.bind(this);
    this.pc.ondatachannel = this._onDataChannel.bind(this);

    // whether to use SDP hack for faster data transfer
    this.config = {
        debug: false,
        sdpHack: true
    };

    // apply our config
    for (item in config) {
        this.config[item] = config[item];
    }

    if (this.config.debug) {
        this.on('*', function (eventName, event) {
            var logger = config.logger || console;
            logger.log('PeerConnection event:', arguments);
        });
    }
}

PeerConnection.prototype = Object.create(WildEmitter.prototype, {
    constructor: {
        value: PeerConnection
    }
});

// Add a stream to the peer connection object
PeerConnection.prototype.addStream = function (stream) {
    this.localStream = stream;
    this.pc.addStream(stream);
};


// Init and add ice candidate object with correct constructor
PeerConnection.prototype.processIce = function (candidate) {
    this.pc.addIceCandidate(new webrtc.IceCandidate(candidate));
};

// Generate and emit an offer with the given constraints
PeerConnection.prototype.offer = function (constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 2;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };
    var callback = hasConstraints ? cb : constraints;

    // Actually generate the offer
    this.pc.createOffer(
        function (offer) {
            offer.sdp = self._applySdpHack(offer.sdp);
            self.pc.setLocalDescription(offer);
            self.emit('offer', offer);
            if (callback) callback(null, offer);
        },
        function (err) {
            self.emit('error', err);
            if (callback) callback(err);
        },
        mediaConstraints
    );
};

// Answer an offer with audio only
PeerConnection.prototype.answerAudioOnly = function (offer, cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: false
            }
        };
    this._answer(offer, mediaConstraints, cb);
};

// Answer an offer without offering to recieve
PeerConnection.prototype.answerBroadcastOnly = function (offer, cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: false,
                OfferToReceiveVideo: false
            }
        };
    this._answer(offer, mediaConstraints, cb);
};

// Answer an offer with given constraints default is audio/video
PeerConnection.prototype.answer = function (offer, constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 3;
    var callback = hasConstraints ? cb : constraints;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

    this._answer(offer, mediaConstraints, callback);
};

// Process an answer
PeerConnection.prototype.handleAnswer = function (answer) {
    this.pc.setRemoteDescription(new webrtc.SessionDescription(answer));
};

// Close the peer connection
PeerConnection.prototype.close = function () {
    this.pc.close();
    this.emit('close');
};

// Internal code sharing for various types of answer methods
PeerConnection.prototype._answer = function (offer, constraints, cb) {
    var self = this;
    this.pc.setRemoteDescription(new webrtc.SessionDescription(offer));
    this.pc.createAnswer(
        function (answer) {
            answer.sdp = self._applySdpHack(answer.sdp);
            self.pc.setLocalDescription(answer);
            self.emit('answer', answer);
            if (cb) cb(null, answer);
        }, function (err) {
            self.emit('error', err);
            if (cb) cb(err);
        },
        constraints
    );
};

// Internal method for emitting ice candidates on our peer object
PeerConnection.prototype._onIce = function (event) {
    if (event.candidate) {
        this.emit('ice', event.candidate);
    } else {
        this.emit('endOfCandidates');
    }
};

// Internal method for processing a new data channel being added by the
// other peer.
PeerConnection.prototype._onDataChannel = function (event) {
    this.emit('addChannel', event.channel);
};

// Internal handling of adding stream
PeerConnection.prototype._onAddStream = function (event) {
    this.remoteStream = event.stream;
    this.emit('addStream', event);
};

// SDP hack for increasing AS (application specific) data transfer speed allowed in chrome
PeerConnection.prototype._applySdpHack = function (sdp) {
    if (!this.config.sdpHack) return sdp;
    var parts = sdp.split('b=AS:30');
    if (parts.length === 2) {
        // increase max data transfer bandwidth to 100 Mbps
        return parts[0] + 'b=AS:102400' + parts[1];
    } else {
        return sdp;
    }
};

// Create a data channel spec reference:
// http://dev.w3.org/2011/webrtc/editor/webrtc.html#idl-def-RTCDataChannelInit
PeerConnection.prototype.createDataChannel = function (name, opts) {
    opts || (opts = {});
    var reliable = !!opts.reliable;
    var protocol = opts.protocol || 'text/plain';
    var negotiated = !!(opts.negotiated || opts.preset);
    var settings;
    var channel;
    // firefox is a bit more finnicky
    if (webrtc.prefix === 'moz') {
        if (reliable) {
            settings = {
                protocol: protocol,
                preset: negotiated,
                stream: name
            };
        } else {
            settings = {};
        }
        channel = this.pc.createDataChannel(name, settings);
        channel.binaryType = 'blob';
    } else {
        if (reliable) {
            settings = {
                reliable: true
            };
        } else {
            settings = {reliable: false};
        }
        channel = this.pc.createDataChannel(name, settings);
    }
    return channel;
};

module.exports = PeerConnection;

},{"webrtcsupport":23,"wildemitter":24}],15:[function(require,module,exports){
var support = require('webrtcsupport');


function GainController(stream) {
    this.support = support.webAudio && support.mediaStream;

    // set our starting value
    this.gain = 1;

    if (this.support) {
        var context = this.context = new support.AudioContext();
        this.microphone = context.createMediaStreamSource(stream);
        this.gainFilter = context.createGain();
        this.destination = context.createMediaStreamDestination();
        this.outputStream = this.destination.stream;
        this.microphone.connect(this.gainFilter);
        this.gainFilter.connect(this.destination);
        stream.removeTrack(stream.getAudioTracks()[0]);
        stream.addTrack(this.outputStream.getAudioTracks()[0]);
    }
    this.stream = stream;
}

// setting
GainController.prototype.setGain = function (val) {
    // check for support
    if (!this.support) return;
    this.gainFilter.gain.value = val;
    this.gain = val;
};

GainController.prototype.getGain = function () {
    return this.gain;
};

GainController.prototype.off = function () {
    return this.setGain(0);
};

GainController.prototype.on = function () {
    this.setGain(1);
};


module.exports = GainController;

},{"webrtcsupport":16}],16:[function(require,module,exports){
// created by @HenrikJoreteg
var PC = window.mozRTCPeerConnection || window.webkitRTCPeerConnection || window.RTCPeerConnection;
var IceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;
var SessionDescription = window.mozRTCSessionDescription || window.RTCSessionDescription;
var prefix = function () {
    if (window.mozRTCPeerConnection) {
        return 'moz';
    } else if (window.webkitRTCPeerConnection) {
        return 'webkit';
    }
}();
var MediaStream = window.webkitMediaStream || window.MediaStream;
var screenSharing = navigator.userAgent.match('Chrome') && parseInt(navigator.userAgent.match(/Chrome\/(.*) /)[1], 10) >= 26;
var AudioContext = window.webkitAudioContext || window.AudioContext;

// export support flags and constructors.prototype && PC
module.exports = {
    support: !!PC,
    dataChannel: !!(PC && PC.prototype && PC.prototype.createDataChannel),
    prefix: prefix,
    webAudio: !!(AudioContext && AudioContext.prototype.createMediaStreamSource),
    mediaStream: !!(MediaStream && MediaStream.prototype.removeTrack),
    screenSharing: screenSharing,
    AudioContext: AudioContext,
    PeerConnection: PC,
    SessionDescription: SessionDescription,
    IceCandidate: IceCandidate
};

},{}],17:[function(require,module,exports){
var methods = "assert,count,debug,dir,dirxml,error,exception,group,groupCollapsed,groupEnd,info,log,markTimeline,profile,profileEnd,time,timeEnd,trace,warn".split(",");
var l = methods.length;
var fn = function () {};
var mockconsole = {};

while (l--) {
    mockconsole[methods[l]] = fn;
}

module.exports = mockconsole;

},{}],18:[function(require,module,exports){
var tosdp = require('./lib/tosdp');
var tojson = require('./lib/tojson');


exports.toSessionSDP = tosdp.toSessionSDP;
exports.toMediaSDP = tosdp.toMediaSDP;
exports.toCandidateSDP = tosdp.toCandidateSDP;

exports.toSessionJSON = tojson.toSessionJSON;
exports.toMediaJSON = tojson.toMediaJSON;
exports.toCandidateJSON = tojson.toCandidateJSON;

},{"./lib/tojson":20,"./lib/tosdp":21}],19:[function(require,module,exports){
exports.lines = function (sdp) {
    return sdp.split('\r\n').filter(function (line) {
        return line.length > 0;
    });
};

exports.findLine = function (prefix, mediaLines, sessionLines) {
    var prefixLength = prefix.length;
    for (var i = 0; i < mediaLines.length; i++) {
        if (mediaLines[i].substr(0, prefixLength) === prefix) {
            return mediaLines[i];
        }
    }
    // Continue searching in parent session section
    if (!sessionLines) {
        return false;
    }

    for (var j = 0; j < sessionLines.length; j++) {
        if (sessionLines[j].substr(0, prefixLength) === prefix) {
            return sessionLines[j];
        }
    }

    return false;
};

exports.findLines = function (prefix, mediaLines, sessionLines) {
    var results = [];
    var prefixLength = prefix.length;
    for (var i = 0; i < mediaLines.length; i++) {
        if (mediaLines[i].substr(0, prefixLength) === prefix) {
            results.push(mediaLines[i]);
        }
    }
    if (results.length || !sessionLines) {
        return results;
    }
    for (var j = 0; j < sessionLines.length; j++) {
        if (sessionLines[j].substr(0, prefixLength) === prefix) {
            results.push(sessionLines[j]);
        }
    }
    return results;
};

exports.mline = function (line) {
    var parts = line.substr(2).split(' ');
    var parsed = {
        media: parts[0],
        port: parts[1],
        proto: parts[2],
        formats: []
    };
    for (var i = 3; i < parts.length; i++) {
        if (parts[i]) {
            parsed.formats.push(parts[i]);
        }
    }
    return parsed;
};

exports.rtpmap = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {
        id: parts.shift()
    };

    parts = parts[0].split('/');

    parsed.name = parts[0];
    parsed.clockrate = parts[1];
    parsed.channels = parts.length == 3 ? parts[2] : '1';
    return parsed;
};

exports.fmtp = function (line) {
    var kv, key, value;
    var parts = line.substr(line.indexOf(' ') + 1).split(';');
    var parsed = [];
    for (var i = 0; i < parts.length; i++) {
        kv = parts[i].split('=');
        key = kv[0].trim();
        value = kv[1];
        if (key && value) {
            parsed.push({key: key, value: value});
        } else if (key) {
            parsed.push({key: '', value: key});
        }
    }
    return parsed;
};

exports.crypto = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {
        tag: parts[0],
        cipherSuite: parts[1],
        keyParams: parts[2],
        sessionParams: parts.slice(3).join(' ')
    };
    return parsed;
};

exports.fingerprint = function (line) {
    var parts = line.substr(14).split(' ');
    return {
        hash: parts[0],
        value: parts[1]
    };
};

exports.extmap = function (line) {
    var parts = line.substr(9).split(' ');
    var parsed = {};

    var idpart = parts.shift();
    var sp = idpart.indexOf('/');
    if (sp >= 0) {
        parsed.id = idpart.substr(0, sp);
        parsed.senders = idpart.substr(sp);
    } else {
        parsed.id = idpart;
        parsed.senders = 'sendrecv';
    }

    parsed.uri = parts.shift();

    return parsed;
};

exports.rtcpfb = function (line) {
    var parts = line.substr(10).split(' ');
    var parsed = {};
    parsed.id = parts.shift();
    parsed.type = parts.shift();
    if (parsed.type === 'trr-int') {
        parsed.value = parts.shift();
    } else {
        parsed.subtype = parts.shift();
    }
    parsed.parameters = parts;
    return parsed;
};

exports.candidate = function (line) {
    var parts = line.substring(12).split(' ');

    var candidate = {
        foundation: parts[0],
        component: parts[1],
        protocol: parts[2].toLowerCase(),
        priority: parts[3],
        ip: parts[4],
        port: parts[5],
        // skip parts[6] == 'typ'
        type: parts[7]
    };

    for (var i = 8; i < parts.length; i += 2) {
        if (parts[i] === 'raddr') {
            candidate.relAddr = parts[i + 1];
        } else if (parts[i] === 'rport') {
            candidate.relPort = parts[i + 1];
        } else if (parts[i] === 'generation') {
            candidate.generation = parts[i + 1];
        }
    }

    candidate.network = '1';

    return candidate;
};

exports.ssrc = function (lines) {
    // http://tools.ietf.org/html/rfc5576
    var parsed = [];
    var perssrc = {};
    var parts;
    var ssrc;
    for (var i = 0; i < lines.length; i++) {
        parts = lines[i].substr(7).split(' ');
        ssrc = parts.shift();
        parts = parts.join(' ').split(':');
        var attribute = parts.shift();
        var value = parts.join(':') || null;
        if (!perssrc[ssrc]) perssrc[ssrc] = {};
        perssrc[ssrc][attribute] = value;
    }
    for (ssrc in perssrc) {
        var item = perssrc[ssrc];
        item.ssrc = ssrc;
        parsed.push(item);
    }
    return parsed;
};

exports.grouping = function (lines) {
    // http://tools.ietf.org/html/rfc5888
    var parsed = [];
    var parts;
    for (var i = 0; i < lines.length; i++) {
        parts = lines[i].substr(8).split(' ');
        parsed.push({
            semantics: parts.shift(),
            contents: parts
        });
    }
    return parsed;
};

},{}],20:[function(require,module,exports){
var parsers = require('./parsers');
var idCounter = Math.random();


exports.toSessionJSON = function (sdp, creator) {
    // Divide the SDP into session and media sections.
    var media = sdp.split('\r\nm=');
    for (var i = 1; i < media.length; i++) {
        media[i] = 'm=' + media[i];
        if (i !== media.length - 1) {
            media[i] += '\r\n';
        }
    }
    var session = media.shift() + '\r\n';
    var sessionLines = parsers.lines(session);
    var parsed = {};

    var contents = [];
    media.forEach(function (m) {
        contents.push(exports.toMediaJSON(m, session, creator));
    });
    parsed.contents = contents;

    var groupLines = parsers.findLines('a=group:', sessionLines);
    if (groupLines.length) {
        parsed.groupings = parsers.grouping(groupLines);
    }

    return parsed;
};

exports.toMediaJSON = function (media, session, creator) {
    var lines = parsers.lines(media);
    var sessionLines = parsers.lines(session);
    var mline = parsers.mline(lines[0]);

    var content = {
        creator: creator,
        name: mline.media,
        description: {
            descType: 'rtp',
            media: mline.media,
            payloads: [],
            encryption: [],
            feedback: [],
            headerExtensions: []
        },
        transport: {
            transType: 'iceUdp',
            candidates: [],
            fingerprints: []
        }
    };
    var desc = content.description;
    var trans = content.transport;

    var ssrc = parsers.findLine('a=ssrc:', lines);
    if (ssrc) {
        desc.ssrc = ssrc.substr(7).split(' ')[0];
    }

    // If we have a mid, use that for the content name instead.
    var mid = parsers.findLine('a=mid:', lines);
    if (mid) {
        content.name = mid.substr(6);
    }

    if (parsers.findLine('a=sendrecv', lines, sessionLines)) {
        content.senders = 'both';
    } else if (parsers.findLine('a=sendonly', lines, sessionLines)) {
        content.senders = 'initiator';
    } else if (parsers.findLine('a=recvonly', lines, sessionLines)) {
        content.senders = 'responder';
    } else if (parsers.findLine('a=inactive', lines, sessionLines)) {
        content.senders = 'none';
    }

    var rtpmapLines = parsers.findLines('a=rtpmap:', lines);
    rtpmapLines.forEach(function (line) {
        var payload = parsers.rtpmap(line);
        payload.feedback = [];

        var fmtpLines = parsers.findLines('a=fmtp:' + payload.id, lines);
        fmtpLines.forEach(function (line) {
            payload.parameters = parsers.fmtp(line);
        });

        var fbLines = parsers.findLines('a=rtcp-fb:' + payload.id, lines);
        fbLines.forEach(function (line) {
            payload.feedback.push(parsers.rtcpfb(line));
        });

        desc.payloads.push(payload);
    });

    var cryptoLines = parsers.findLines('a=crypto:', lines, sessionLines);
    cryptoLines.forEach(function (line) {
        desc.encryption.push(parsers.crypto(line));
    });

    if (parsers.findLine('a=rtcp-mux', lines)) {
        desc.mux = true;
    }

    var fbLines = parsers.findLines('a=rtcp-fb:*', lines);
    fbLines.forEach(function (line) {
        desc.feedback.push(parsers.rtcpfb(line));
    });

    var extLines = parsers.findLines('a=extmap:', lines);
    extLines.forEach(function (line) {
        var ext = parsers.extmap(line);

        var senders = {
            sendonly: 'responder',
            recvonly: 'initiator',
            sendrecv: 'both',
            inactive: 'none'
        };
        ext.senders = senders[ext.senders];

        desc.headerExtensions.push(ext);
    });

    var ssrcLines = parsers.findLines('a=ssrc:', lines);
    if (ssrcLines.length) {
        desc.ssrcs = parsers.ssrc(ssrcLines);
    }

    var fingerprintLines = parsers.findLines('a=fingerprint:', lines, sessionLines);
    fingerprintLines.forEach(function (line) {
        trans.fingerprints.push(parsers.fingerprint(line));
    });

    var ufragLine = parsers.findLine('a=ice-ufrag:', lines, sessionLines);
    var pwdLine = parsers.findLine('a=ice-pwd:', lines, sessionLines);
    if (ufragLine && pwdLine) {
        trans.ufrag = ufragLine.substr(12);
        trans.pwd = pwdLine.substr(10);
        trans.candidates = [];

        var candidateLines = parsers.findLines('a=candidate:', lines, sessionLines);
        candidateLines.forEach(function (line) {
            trans.candidates.push(exports.toCandidateJSON(line));
        });
    }

    return content;
};

exports.toCandidateJSON = function (line) {
    var candidate = parsers.candidate(line.split('\r\n')[0]);
    candidate.id = (idCounter++).toString(36).substr(0, 12);
    return candidate;
};

},{"./parsers":19}],21:[function(require,module,exports){
var senders = {
    'initiator': 'sendonly',
    'responder': 'recvonly',
    'both': 'sendrecv',
    'none': 'inactive',
    'sendonly': 'initator',
    'recvonly': 'responder',
    'sendrecv': 'both',
    'inactive': 'none'
};


exports.toSessionSDP = function (session, sid) {
    var sdp = [
        'v=0',
        'o=- ' + (sid || session.sid || Date.now()) + ' ' + Date.now() + ' IN IP4 0.0.0.0',
        's=-',
        't=0 0'
    ];

    var groupings = session.groupings || [];
    groupings.forEach(function (grouping) {
        sdp.push('a=group:' + grouping.semantics + ' ' + grouping.contents.join(' '));
    });

    var contents = session.contents || [];
    contents.forEach(function (content) {
        sdp.push(exports.toMediaSDP(content));
    });

    return sdp.join('\r\n') + '\r\n';
};

exports.toMediaSDP = function (content) {
    var sdp = [];

    var desc = content.description;
    var transport = content.transport;
    var payloads = desc.payloads || [];
    var fingerprints = (transport && transport.fingerprints) || [];

    var mline = [desc.media, '1'];

    if ((desc.encryption && desc.encryption.length > 0) || (fingerprints.length > 0)) {
        mline.push('RTP/SAVPF');
    } else {
        mline.push('RTP/AVPF');
    }
    payloads.forEach(function (payload) {
        mline.push(payload.id);
    });


    sdp.push('m=' + mline.join(' '));

    sdp.push('c=IN IP4 0.0.0.0');
    sdp.push('a=rtcp:1 IN IP4 0.0.0.0');

    if (transport) {
        if (transport.ufrag) {
            sdp.push('a=ice-ufrag:' + transport.ufrag);
        }
        if (transport.pwd) {
            sdp.push('a=ice-pwd:' + transport.pwd);
        }
        fingerprints.forEach(function (fingerprint) {
            sdp.push('a=fingerprint:' + fingerprint.hash + ' ' + fingerprint.value);
        });
    }

    sdp.push('a=' + (senders[content.senders] || 'sendrecv'));
    sdp.push('a=mid:' + content.name);

    if (desc.mux) {
        sdp.push('a=rtcp-mux');
    }

    var encryption = desc.encryption || [];
    encryption.forEach(function (crypto) {
        sdp.push('a=crypto:' + crypto.tag + ' ' + crypto.cipherSuite + ' ' + crypto.keyParams + (crypto.sessionParams ? ' ' + crypto.sessionParams : ''));
    });

    payloads.forEach(function (payload) {
        var rtpmap = 'a=rtpmap:' + payload.id + ' ' + payload.name + '/' + payload.clockrate;
        if (payload.channels && payload.channels != '1') {
            rtpmap += '/' + payload.channels;
        }
        sdp.push(rtpmap);

        if (payload.parameters && payload.parameters.length) {
            var fmtp = ['a=fmtp:' + payload.id];
            payload.parameters.forEach(function (param) {
                fmtp.push((param.key ? param.key + '=' : '') + param.value);
            });
            sdp.push(fmtp.join(' '));
        }

        if (payload.feedback) {
            payload.feedback.forEach(function (fb) {
                if (fb.type === 'trr-int') {
                    sdp.push('a=rtcp-fb:' + payload.id + ' trr-int ' + fb.value ? fb.value : '0');
                } else {
                    sdp.push('a=rtcp-fb:' + payload.id + ' ' + fb.type + (fb.subtype ? ' ' + fb.subtype : ''));
                }
            });
        }
    });

    if (desc.feedback) {
        desc.feedback.forEach(function (fb) {
            if (fb.type === 'trr-int') {
                sdp.push('a=rtcp-fb:* trr-int ' + fb.value ? fb.value : '0');
            } else {
                sdp.push('a=rtcp-fb:* ' + fb.type + (fb.subtype ? ' ' + fb.subtype : ''));
            }
        });
    }

    var hdrExts = desc.headerExtensions || [];
    hdrExts.forEach(function (hdr) {
        sdp.push('a=extmap:' + hdr.id + (hdr.senders ? '/' + senders[hdr.senders] : '') + ' ' + hdr.uri);
    });

    var ssrcs = desc.ssrcs || [];
    ssrcs.forEach(function (ssrc) {
        for (var attribute in ssrc) {
            if (attribute == 'ssrc') continue;
            sdp.push('a=ssrc:' + (ssrc.ssrc || desc.ssrc) + ' ' + attribute + (ssrc[attribute] ? (':' + ssrc[attribute]) : ''));
        }
    });

    var candidates = transport.candidates || [];
    candidates.forEach(function (candidate) {
        sdp.push(exports.toCandidateSDP(candidate));
    });

    return sdp.join('\r\n');
};

exports.toCandidateSDP = function (candidate) {
    var sdp = [];

    sdp.push(candidate.foundation);
    sdp.push(candidate.component);
    sdp.push(candidate.protocol);
    sdp.push(candidate.priority);
    sdp.push(candidate.ip);
    sdp.push(candidate.port);

    var type = candidate.type;
    sdp.push('typ');
    sdp.push(type);
    if (type === 'srflx' || type === 'prflx' || type === 'relay') {
        if (candidate.relAddr && candidate.relPort) {
            sdp.push('raddr');
            sdp.push(candidate.relAddr);
            sdp.push('rport');
            sdp.push(candidate.relPort);
        }
    }

    sdp.push('generation');
    sdp.push(candidate.generation || '0');

    return 'a=candidate:' + sdp.join(' ');
};

},{}],22:[function(require,module,exports){
//     Underscore.js 1.5.2
//     http://underscorejs.org
//     (c) 2009-2013 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
//     Underscore may be freely distributed under the MIT license.

(function() {

  // Baseline setup
  // --------------

  // Establish the root object, `window` in the browser, or `exports` on the server.
  var root = this;

  // Save the previous value of the `_` variable.
  var previousUnderscore = root._;

  // Establish the object that gets returned to break out of a loop iteration.
  var breaker = {};

  // Save bytes in the minified (but not gzipped) version:
  var ArrayProto = Array.prototype, ObjProto = Object.prototype, FuncProto = Function.prototype;

  // Create quick reference variables for speed access to core prototypes.
  var
    push             = ArrayProto.push,
    slice            = ArrayProto.slice,
    concat           = ArrayProto.concat,
    toString         = ObjProto.toString,
    hasOwnProperty   = ObjProto.hasOwnProperty;

  // All **ECMAScript 5** native function implementations that we hope to use
  // are declared here.
  var
    nativeForEach      = ArrayProto.forEach,
    nativeMap          = ArrayProto.map,
    nativeReduce       = ArrayProto.reduce,
    nativeReduceRight  = ArrayProto.reduceRight,
    nativeFilter       = ArrayProto.filter,
    nativeEvery        = ArrayProto.every,
    nativeSome         = ArrayProto.some,
    nativeIndexOf      = ArrayProto.indexOf,
    nativeLastIndexOf  = ArrayProto.lastIndexOf,
    nativeIsArray      = Array.isArray,
    nativeKeys         = Object.keys,
    nativeBind         = FuncProto.bind;

  // Create a safe reference to the Underscore object for use below.
  var _ = function(obj) {
    if (obj instanceof _) return obj;
    if (!(this instanceof _)) return new _(obj);
    this._wrapped = obj;
  };

  // Export the Underscore object for **Node.js**, with
  // backwards-compatibility for the old `require()` API. If we're in
  // the browser, add `_` as a global object via a string identifier,
  // for Closure Compiler "advanced" mode.
  if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      exports = module.exports = _;
    }
    exports._ = _;
  } else {
    root._ = _;
  }

  // Current version.
  _.VERSION = '1.5.2';

  // Collection Functions
  // --------------------

  // The cornerstone, an `each` implementation, aka `forEach`.
  // Handles objects with the built-in `forEach`, arrays, and raw objects.
  // Delegates to **ECMAScript 5**'s native `forEach` if available.
  var each = _.each = _.forEach = function(obj, iterator, context) {
    if (obj == null) return;
    if (nativeForEach && obj.forEach === nativeForEach) {
      obj.forEach(iterator, context);
    } else if (obj.length === +obj.length) {
      for (var i = 0, length = obj.length; i < length; i++) {
        if (iterator.call(context, obj[i], i, obj) === breaker) return;
      }
    } else {
      var keys = _.keys(obj);
      for (var i = 0, length = keys.length; i < length; i++) {
        if (iterator.call(context, obj[keys[i]], keys[i], obj) === breaker) return;
      }
    }
  };

  // Return the results of applying the iterator to each element.
  // Delegates to **ECMAScript 5**'s native `map` if available.
  _.map = _.collect = function(obj, iterator, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeMap && obj.map === nativeMap) return obj.map(iterator, context);
    each(obj, function(value, index, list) {
      results.push(iterator.call(context, value, index, list));
    });
    return results;
  };

  var reduceError = 'Reduce of empty array with no initial value';

  // **Reduce** builds up a single result from a list of values, aka `inject`,
  // or `foldl`. Delegates to **ECMAScript 5**'s native `reduce` if available.
  _.reduce = _.foldl = _.inject = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduce && obj.reduce === nativeReduce) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduce(iterator, memo) : obj.reduce(iterator);
    }
    each(obj, function(value, index, list) {
      if (!initial) {
        memo = value;
        initial = true;
      } else {
        memo = iterator.call(context, memo, value, index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // The right-associative version of reduce, also known as `foldr`.
  // Delegates to **ECMAScript 5**'s native `reduceRight` if available.
  _.reduceRight = _.foldr = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduceRight && obj.reduceRight === nativeReduceRight) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduceRight(iterator, memo) : obj.reduceRight(iterator);
    }
    var length = obj.length;
    if (length !== +length) {
      var keys = _.keys(obj);
      length = keys.length;
    }
    each(obj, function(value, index, list) {
      index = keys ? keys[--length] : --length;
      if (!initial) {
        memo = obj[index];
        initial = true;
      } else {
        memo = iterator.call(context, memo, obj[index], index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // Return the first value which passes a truth test. Aliased as `detect`.
  _.find = _.detect = function(obj, iterator, context) {
    var result;
    any(obj, function(value, index, list) {
      if (iterator.call(context, value, index, list)) {
        result = value;
        return true;
      }
    });
    return result;
  };

  // Return all the elements that pass a truth test.
  // Delegates to **ECMAScript 5**'s native `filter` if available.
  // Aliased as `select`.
  _.filter = _.select = function(obj, iterator, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeFilter && obj.filter === nativeFilter) return obj.filter(iterator, context);
    each(obj, function(value, index, list) {
      if (iterator.call(context, value, index, list)) results.push(value);
    });
    return results;
  };

  // Return all the elements for which a truth test fails.
  _.reject = function(obj, iterator, context) {
    return _.filter(obj, function(value, index, list) {
      return !iterator.call(context, value, index, list);
    }, context);
  };

  // Determine whether all of the elements match a truth test.
  // Delegates to **ECMAScript 5**'s native `every` if available.
  // Aliased as `all`.
  _.every = _.all = function(obj, iterator, context) {
    iterator || (iterator = _.identity);
    var result = true;
    if (obj == null) return result;
    if (nativeEvery && obj.every === nativeEvery) return obj.every(iterator, context);
    each(obj, function(value, index, list) {
      if (!(result = result && iterator.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if at least one element in the object matches a truth test.
  // Delegates to **ECMAScript 5**'s native `some` if available.
  // Aliased as `any`.
  var any = _.some = _.any = function(obj, iterator, context) {
    iterator || (iterator = _.identity);
    var result = false;
    if (obj == null) return result;
    if (nativeSome && obj.some === nativeSome) return obj.some(iterator, context);
    each(obj, function(value, index, list) {
      if (result || (result = iterator.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if the array or object contains a given value (using `===`).
  // Aliased as `include`.
  _.contains = _.include = function(obj, target) {
    if (obj == null) return false;
    if (nativeIndexOf && obj.indexOf === nativeIndexOf) return obj.indexOf(target) != -1;
    return any(obj, function(value) {
      return value === target;
    });
  };

  // Invoke a method (with arguments) on every item in a collection.
  _.invoke = function(obj, method) {
    var args = slice.call(arguments, 2);
    var isFunc = _.isFunction(method);
    return _.map(obj, function(value) {
      return (isFunc ? method : value[method]).apply(value, args);
    });
  };

  // Convenience version of a common use case of `map`: fetching a property.
  _.pluck = function(obj, key) {
    return _.map(obj, function(value){ return value[key]; });
  };

  // Convenience version of a common use case of `filter`: selecting only objects
  // containing specific `key:value` pairs.
  _.where = function(obj, attrs, first) {
    if (_.isEmpty(attrs)) return first ? void 0 : [];
    return _[first ? 'find' : 'filter'](obj, function(value) {
      for (var key in attrs) {
        if (attrs[key] !== value[key]) return false;
      }
      return true;
    });
  };

  // Convenience version of a common use case of `find`: getting the first object
  // containing specific `key:value` pairs.
  _.findWhere = function(obj, attrs) {
    return _.where(obj, attrs, true);
  };

  // Return the maximum element or (element-based computation).
  // Can't optimize arrays of integers longer than 65,535 elements.
  // See [WebKit Bug 80797](https://bugs.webkit.org/show_bug.cgi?id=80797)
  _.max = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.max.apply(Math, obj);
    }
    if (!iterator && _.isEmpty(obj)) return -Infinity;
    var result = {computed : -Infinity, value: -Infinity};
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      computed > result.computed && (result = {value : value, computed : computed});
    });
    return result.value;
  };

  // Return the minimum element (or element-based computation).
  _.min = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.min.apply(Math, obj);
    }
    if (!iterator && _.isEmpty(obj)) return Infinity;
    var result = {computed : Infinity, value: Infinity};
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      computed < result.computed && (result = {value : value, computed : computed});
    });
    return result.value;
  };

  // Shuffle an array, using the modern version of the 
  // [Fisher-Yates shuffle](http://en.wikipedia.org/wiki/Fisher–Yates_shuffle).
  _.shuffle = function(obj) {
    var rand;
    var index = 0;
    var shuffled = [];
    each(obj, function(value) {
      rand = _.random(index++);
      shuffled[index - 1] = shuffled[rand];
      shuffled[rand] = value;
    });
    return shuffled;
  };

  // Sample **n** random values from an array.
  // If **n** is not specified, returns a single random element from the array.
  // The internal `guard` argument allows it to work with `map`.
  _.sample = function(obj, n, guard) {
    if (arguments.length < 2 || guard) {
      return obj[_.random(obj.length - 1)];
    }
    return _.shuffle(obj).slice(0, Math.max(0, n));
  };

  // An internal function to generate lookup iterators.
  var lookupIterator = function(value) {
    return _.isFunction(value) ? value : function(obj){ return obj[value]; };
  };

  // Sort the object's values by a criterion produced by an iterator.
  _.sortBy = function(obj, value, context) {
    var iterator = lookupIterator(value);
    return _.pluck(_.map(obj, function(value, index, list) {
      return {
        value: value,
        index: index,
        criteria: iterator.call(context, value, index, list)
      };
    }).sort(function(left, right) {
      var a = left.criteria;
      var b = right.criteria;
      if (a !== b) {
        if (a > b || a === void 0) return 1;
        if (a < b || b === void 0) return -1;
      }
      return left.index - right.index;
    }), 'value');
  };

  // An internal function used for aggregate "group by" operations.
  var group = function(behavior) {
    return function(obj, value, context) {
      var result = {};
      var iterator = value == null ? _.identity : lookupIterator(value);
      each(obj, function(value, index) {
        var key = iterator.call(context, value, index, obj);
        behavior(result, key, value);
      });
      return result;
    };
  };

  // Groups the object's values by a criterion. Pass either a string attribute
  // to group by, or a function that returns the criterion.
  _.groupBy = group(function(result, key, value) {
    (_.has(result, key) ? result[key] : (result[key] = [])).push(value);
  });

  // Indexes the object's values by a criterion, similar to `groupBy`, but for
  // when you know that your index values will be unique.
  _.indexBy = group(function(result, key, value) {
    result[key] = value;
  });

  // Counts instances of an object that group by a certain criterion. Pass
  // either a string attribute to count by, or a function that returns the
  // criterion.
  _.countBy = group(function(result, key) {
    _.has(result, key) ? result[key]++ : result[key] = 1;
  });

  // Use a comparator function to figure out the smallest index at which
  // an object should be inserted so as to maintain order. Uses binary search.
  _.sortedIndex = function(array, obj, iterator, context) {
    iterator = iterator == null ? _.identity : lookupIterator(iterator);
    var value = iterator.call(context, obj);
    var low = 0, high = array.length;
    while (low < high) {
      var mid = (low + high) >>> 1;
      iterator.call(context, array[mid]) < value ? low = mid + 1 : high = mid;
    }
    return low;
  };

  // Safely create a real, live array from anything iterable.
  _.toArray = function(obj) {
    if (!obj) return [];
    if (_.isArray(obj)) return slice.call(obj);
    if (obj.length === +obj.length) return _.map(obj, _.identity);
    return _.values(obj);
  };

  // Return the number of elements in an object.
  _.size = function(obj) {
    if (obj == null) return 0;
    return (obj.length === +obj.length) ? obj.length : _.keys(obj).length;
  };

  // Array Functions
  // ---------------

  // Get the first element of an array. Passing **n** will return the first N
  // values in the array. Aliased as `head` and `take`. The **guard** check
  // allows it to work with `_.map`.
  _.first = _.head = _.take = function(array, n, guard) {
    if (array == null) return void 0;
    return (n == null) || guard ? array[0] : slice.call(array, 0, n);
  };

  // Returns everything but the last entry of the array. Especially useful on
  // the arguments object. Passing **n** will return all the values in
  // the array, excluding the last N. The **guard** check allows it to work with
  // `_.map`.
  _.initial = function(array, n, guard) {
    return slice.call(array, 0, array.length - ((n == null) || guard ? 1 : n));
  };

  // Get the last element of an array. Passing **n** will return the last N
  // values in the array. The **guard** check allows it to work with `_.map`.
  _.last = function(array, n, guard) {
    if (array == null) return void 0;
    if ((n == null) || guard) {
      return array[array.length - 1];
    } else {
      return slice.call(array, Math.max(array.length - n, 0));
    }
  };

  // Returns everything but the first entry of the array. Aliased as `tail` and `drop`.
  // Especially useful on the arguments object. Passing an **n** will return
  // the rest N values in the array. The **guard**
  // check allows it to work with `_.map`.
  _.rest = _.tail = _.drop = function(array, n, guard) {
    return slice.call(array, (n == null) || guard ? 1 : n);
  };

  // Trim out all falsy values from an array.
  _.compact = function(array) {
    return _.filter(array, _.identity);
  };

  // Internal implementation of a recursive `flatten` function.
  var flatten = function(input, shallow, output) {
    if (shallow && _.every(input, _.isArray)) {
      return concat.apply(output, input);
    }
    each(input, function(value) {
      if (_.isArray(value) || _.isArguments(value)) {
        shallow ? push.apply(output, value) : flatten(value, shallow, output);
      } else {
        output.push(value);
      }
    });
    return output;
  };

  // Flatten out an array, either recursively (by default), or just one level.
  _.flatten = function(array, shallow) {
    return flatten(array, shallow, []);
  };

  // Return a version of the array that does not contain the specified value(s).
  _.without = function(array) {
    return _.difference(array, slice.call(arguments, 1));
  };

  // Produce a duplicate-free version of the array. If the array has already
  // been sorted, you have the option of using a faster algorithm.
  // Aliased as `unique`.
  _.uniq = _.unique = function(array, isSorted, iterator, context) {
    if (_.isFunction(isSorted)) {
      context = iterator;
      iterator = isSorted;
      isSorted = false;
    }
    var initial = iterator ? _.map(array, iterator, context) : array;
    var results = [];
    var seen = [];
    each(initial, function(value, index) {
      if (isSorted ? (!index || seen[seen.length - 1] !== value) : !_.contains(seen, value)) {
        seen.push(value);
        results.push(array[index]);
      }
    });
    return results;
  };

  // Produce an array that contains the union: each distinct element from all of
  // the passed-in arrays.
  _.union = function() {
    return _.uniq(_.flatten(arguments, true));
  };

  // Produce an array that contains every item shared between all the
  // passed-in arrays.
  _.intersection = function(array) {
    var rest = slice.call(arguments, 1);
    return _.filter(_.uniq(array), function(item) {
      return _.every(rest, function(other) {
        return _.indexOf(other, item) >= 0;
      });
    });
  };

  // Take the difference between one array and a number of other arrays.
  // Only the elements present in just the first array will remain.
  _.difference = function(array) {
    var rest = concat.apply(ArrayProto, slice.call(arguments, 1));
    return _.filter(array, function(value){ return !_.contains(rest, value); });
  };

  // Zip together multiple lists into a single array -- elements that share
  // an index go together.
  _.zip = function() {
    var length = _.max(_.pluck(arguments, "length").concat(0));
    var results = new Array(length);
    for (var i = 0; i < length; i++) {
      results[i] = _.pluck(arguments, '' + i);
    }
    return results;
  };

  // Converts lists into objects. Pass either a single array of `[key, value]`
  // pairs, or two parallel arrays of the same length -- one of keys, and one of
  // the corresponding values.
  _.object = function(list, values) {
    if (list == null) return {};
    var result = {};
    for (var i = 0, length = list.length; i < length; i++) {
      if (values) {
        result[list[i]] = values[i];
      } else {
        result[list[i][0]] = list[i][1];
      }
    }
    return result;
  };

  // If the browser doesn't supply us with indexOf (I'm looking at you, **MSIE**),
  // we need this function. Return the position of the first occurrence of an
  // item in an array, or -1 if the item is not included in the array.
  // Delegates to **ECMAScript 5**'s native `indexOf` if available.
  // If the array is large and already in sort order, pass `true`
  // for **isSorted** to use binary search.
  _.indexOf = function(array, item, isSorted) {
    if (array == null) return -1;
    var i = 0, length = array.length;
    if (isSorted) {
      if (typeof isSorted == 'number') {
        i = (isSorted < 0 ? Math.max(0, length + isSorted) : isSorted);
      } else {
        i = _.sortedIndex(array, item);
        return array[i] === item ? i : -1;
      }
    }
    if (nativeIndexOf && array.indexOf === nativeIndexOf) return array.indexOf(item, isSorted);
    for (; i < length; i++) if (array[i] === item) return i;
    return -1;
  };

  // Delegates to **ECMAScript 5**'s native `lastIndexOf` if available.
  _.lastIndexOf = function(array, item, from) {
    if (array == null) return -1;
    var hasIndex = from != null;
    if (nativeLastIndexOf && array.lastIndexOf === nativeLastIndexOf) {
      return hasIndex ? array.lastIndexOf(item, from) : array.lastIndexOf(item);
    }
    var i = (hasIndex ? from : array.length);
    while (i--) if (array[i] === item) return i;
    return -1;
  };

  // Generate an integer Array containing an arithmetic progression. A port of
  // the native Python `range()` function. See
  // [the Python documentation](http://docs.python.org/library/functions.html#range).
  _.range = function(start, stop, step) {
    if (arguments.length <= 1) {
      stop = start || 0;
      start = 0;
    }
    step = arguments[2] || 1;

    var length = Math.max(Math.ceil((stop - start) / step), 0);
    var idx = 0;
    var range = new Array(length);

    while(idx < length) {
      range[idx++] = start;
      start += step;
    }

    return range;
  };

  // Function (ahem) Functions
  // ------------------

  // Reusable constructor function for prototype setting.
  var ctor = function(){};

  // Create a function bound to a given object (assigning `this`, and arguments,
  // optionally). Delegates to **ECMAScript 5**'s native `Function.bind` if
  // available.
  _.bind = function(func, context) {
    var args, bound;
    if (nativeBind && func.bind === nativeBind) return nativeBind.apply(func, slice.call(arguments, 1));
    if (!_.isFunction(func)) throw new TypeError;
    args = slice.call(arguments, 2);
    return bound = function() {
      if (!(this instanceof bound)) return func.apply(context, args.concat(slice.call(arguments)));
      ctor.prototype = func.prototype;
      var self = new ctor;
      ctor.prototype = null;
      var result = func.apply(self, args.concat(slice.call(arguments)));
      if (Object(result) === result) return result;
      return self;
    };
  };

  // Partially apply a function by creating a version that has had some of its
  // arguments pre-filled, without changing its dynamic `this` context.
  _.partial = function(func) {
    var args = slice.call(arguments, 1);
    return function() {
      return func.apply(this, args.concat(slice.call(arguments)));
    };
  };

  // Bind all of an object's methods to that object. Useful for ensuring that
  // all callbacks defined on an object belong to it.
  _.bindAll = function(obj) {
    var funcs = slice.call(arguments, 1);
    if (funcs.length === 0) throw new Error("bindAll must be passed function names");
    each(funcs, function(f) { obj[f] = _.bind(obj[f], obj); });
    return obj;
  };

  // Memoize an expensive function by storing its results.
  _.memoize = function(func, hasher) {
    var memo = {};
    hasher || (hasher = _.identity);
    return function() {
      var key = hasher.apply(this, arguments);
      return _.has(memo, key) ? memo[key] : (memo[key] = func.apply(this, arguments));
    };
  };

  // Delays a function for the given number of milliseconds, and then calls
  // it with the arguments supplied.
  _.delay = function(func, wait) {
    var args = slice.call(arguments, 2);
    return setTimeout(function(){ return func.apply(null, args); }, wait);
  };

  // Defers a function, scheduling it to run after the current call stack has
  // cleared.
  _.defer = function(func) {
    return _.delay.apply(_, [func, 1].concat(slice.call(arguments, 1)));
  };

  // Returns a function, that, when invoked, will only be triggered at most once
  // during a given window of time. Normally, the throttled function will run
  // as much as it can, without ever going more than once per `wait` duration;
  // but if you'd like to disable the execution on the leading edge, pass
  // `{leading: false}`. To disable execution on the trailing edge, ditto.
  _.throttle = function(func, wait, options) {
    var context, args, result;
    var timeout = null;
    var previous = 0;
    options || (options = {});
    var later = function() {
      previous = options.leading === false ? 0 : new Date;
      timeout = null;
      result = func.apply(context, args);
    };
    return function() {
      var now = new Date;
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
        result = func.apply(context, args);
      } else if (!timeout && options.trailing !== false) {
        timeout = setTimeout(later, remaining);
      }
      return result;
    };
  };

  // Returns a function, that, as long as it continues to be invoked, will not
  // be triggered. The function will be called after it stops being called for
  // N milliseconds. If `immediate` is passed, trigger the function on the
  // leading edge, instead of the trailing.
  _.debounce = function(func, wait, immediate) {
    var timeout, args, context, timestamp, result;
    return function() {
      context = this;
      args = arguments;
      timestamp = new Date();
      var later = function() {
        var last = (new Date()) - timestamp;
        if (last < wait) {
          timeout = setTimeout(later, wait - last);
        } else {
          timeout = null;
          if (!immediate) result = func.apply(context, args);
        }
      };
      var callNow = immediate && !timeout;
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      if (callNow) result = func.apply(context, args);
      return result;
    };
  };

  // Returns a function that will be executed at most one time, no matter how
  // often you call it. Useful for lazy initialization.
  _.once = function(func) {
    var ran = false, memo;
    return function() {
      if (ran) return memo;
      ran = true;
      memo = func.apply(this, arguments);
      func = null;
      return memo;
    };
  };

  // Returns the first function passed as an argument to the second,
  // allowing you to adjust arguments, run code before and after, and
  // conditionally execute the original function.
  _.wrap = function(func, wrapper) {
    return function() {
      var args = [func];
      push.apply(args, arguments);
      return wrapper.apply(this, args);
    };
  };

  // Returns a function that is the composition of a list of functions, each
  // consuming the return value of the function that follows.
  _.compose = function() {
    var funcs = arguments;
    return function() {
      var args = arguments;
      for (var i = funcs.length - 1; i >= 0; i--) {
        args = [funcs[i].apply(this, args)];
      }
      return args[0];
    };
  };

  // Returns a function that will only be executed after being called N times.
  _.after = function(times, func) {
    return function() {
      if (--times < 1) {
        return func.apply(this, arguments);
      }
    };
  };

  // Object Functions
  // ----------------

  // Retrieve the names of an object's properties.
  // Delegates to **ECMAScript 5**'s native `Object.keys`
  _.keys = nativeKeys || function(obj) {
    if (obj !== Object(obj)) throw new TypeError('Invalid object');
    var keys = [];
    for (var key in obj) if (_.has(obj, key)) keys.push(key);
    return keys;
  };

  // Retrieve the values of an object's properties.
  _.values = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var values = new Array(length);
    for (var i = 0; i < length; i++) {
      values[i] = obj[keys[i]];
    }
    return values;
  };

  // Convert an object into a list of `[key, value]` pairs.
  _.pairs = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var pairs = new Array(length);
    for (var i = 0; i < length; i++) {
      pairs[i] = [keys[i], obj[keys[i]]];
    }
    return pairs;
  };

  // Invert the keys and values of an object. The values must be serializable.
  _.invert = function(obj) {
    var result = {};
    var keys = _.keys(obj);
    for (var i = 0, length = keys.length; i < length; i++) {
      result[obj[keys[i]]] = keys[i];
    }
    return result;
  };

  // Return a sorted list of the function names available on the object.
  // Aliased as `methods`
  _.functions = _.methods = function(obj) {
    var names = [];
    for (var key in obj) {
      if (_.isFunction(obj[key])) names.push(key);
    }
    return names.sort();
  };

  // Extend a given object with all the properties in passed-in object(s).
  _.extend = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Return a copy of the object only containing the whitelisted properties.
  _.pick = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    each(keys, function(key) {
      if (key in obj) copy[key] = obj[key];
    });
    return copy;
  };

   // Return a copy of the object without the blacklisted properties.
  _.omit = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    for (var key in obj) {
      if (!_.contains(keys, key)) copy[key] = obj[key];
    }
    return copy;
  };

  // Fill in a given object with default properties.
  _.defaults = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          if (obj[prop] === void 0) obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Create a (shallow-cloned) duplicate of an object.
  _.clone = function(obj) {
    if (!_.isObject(obj)) return obj;
    return _.isArray(obj) ? obj.slice() : _.extend({}, obj);
  };

  // Invokes interceptor with the obj, and then returns obj.
  // The primary purpose of this method is to "tap into" a method chain, in
  // order to perform operations on intermediate results within the chain.
  _.tap = function(obj, interceptor) {
    interceptor(obj);
    return obj;
  };

  // Internal recursive comparison function for `isEqual`.
  var eq = function(a, b, aStack, bStack) {
    // Identical objects are equal. `0 === -0`, but they aren't identical.
    // See the [Harmony `egal` proposal](http://wiki.ecmascript.org/doku.php?id=harmony:egal).
    if (a === b) return a !== 0 || 1 / a == 1 / b;
    // A strict comparison is necessary because `null == undefined`.
    if (a == null || b == null) return a === b;
    // Unwrap any wrapped objects.
    if (a instanceof _) a = a._wrapped;
    if (b instanceof _) b = b._wrapped;
    // Compare `[[Class]]` names.
    var className = toString.call(a);
    if (className != toString.call(b)) return false;
    switch (className) {
      // Strings, numbers, dates, and booleans are compared by value.
      case '[object String]':
        // Primitives and their corresponding object wrappers are equivalent; thus, `"5"` is
        // equivalent to `new String("5")`.
        return a == String(b);
      case '[object Number]':
        // `NaN`s are equivalent, but non-reflexive. An `egal` comparison is performed for
        // other numeric values.
        return a != +a ? b != +b : (a == 0 ? 1 / a == 1 / b : a == +b);
      case '[object Date]':
      case '[object Boolean]':
        // Coerce dates and booleans to numeric primitive values. Dates are compared by their
        // millisecond representations. Note that invalid dates with millisecond representations
        // of `NaN` are not equivalent.
        return +a == +b;
      // RegExps are compared by their source patterns and flags.
      case '[object RegExp]':
        return a.source == b.source &&
               a.global == b.global &&
               a.multiline == b.multiline &&
               a.ignoreCase == b.ignoreCase;
    }
    if (typeof a != 'object' || typeof b != 'object') return false;
    // Assume equality for cyclic structures. The algorithm for detecting cyclic
    // structures is adapted from ES 5.1 section 15.12.3, abstract operation `JO`.
    var length = aStack.length;
    while (length--) {
      // Linear search. Performance is inversely proportional to the number of
      // unique nested structures.
      if (aStack[length] == a) return bStack[length] == b;
    }
    // Objects with different constructors are not equivalent, but `Object`s
    // from different frames are.
    var aCtor = a.constructor, bCtor = b.constructor;
    if (aCtor !== bCtor && !(_.isFunction(aCtor) && (aCtor instanceof aCtor) &&
                             _.isFunction(bCtor) && (bCtor instanceof bCtor))) {
      return false;
    }
    // Add the first object to the stack of traversed objects.
    aStack.push(a);
    bStack.push(b);
    var size = 0, result = true;
    // Recursively compare objects and arrays.
    if (className == '[object Array]') {
      // Compare array lengths to determine if a deep comparison is necessary.
      size = a.length;
      result = size == b.length;
      if (result) {
        // Deep compare the contents, ignoring non-numeric properties.
        while (size--) {
          if (!(result = eq(a[size], b[size], aStack, bStack))) break;
        }
      }
    } else {
      // Deep compare objects.
      for (var key in a) {
        if (_.has(a, key)) {
          // Count the expected number of properties.
          size++;
          // Deep compare each member.
          if (!(result = _.has(b, key) && eq(a[key], b[key], aStack, bStack))) break;
        }
      }
      // Ensure that both objects contain the same number of properties.
      if (result) {
        for (key in b) {
          if (_.has(b, key) && !(size--)) break;
        }
        result = !size;
      }
    }
    // Remove the first object from the stack of traversed objects.
    aStack.pop();
    bStack.pop();
    return result;
  };

  // Perform a deep comparison to check if two objects are equal.
  _.isEqual = function(a, b) {
    return eq(a, b, [], []);
  };

  // Is a given array, string, or object empty?
  // An "empty" object has no enumerable own-properties.
  _.isEmpty = function(obj) {
    if (obj == null) return true;
    if (_.isArray(obj) || _.isString(obj)) return obj.length === 0;
    for (var key in obj) if (_.has(obj, key)) return false;
    return true;
  };

  // Is a given value a DOM element?
  _.isElement = function(obj) {
    return !!(obj && obj.nodeType === 1);
  };

  // Is a given value an array?
  // Delegates to ECMA5's native Array.isArray
  _.isArray = nativeIsArray || function(obj) {
    return toString.call(obj) == '[object Array]';
  };

  // Is a given variable an object?
  _.isObject = function(obj) {
    return obj === Object(obj);
  };

  // Add some isType methods: isArguments, isFunction, isString, isNumber, isDate, isRegExp.
  each(['Arguments', 'Function', 'String', 'Number', 'Date', 'RegExp'], function(name) {
    _['is' + name] = function(obj) {
      return toString.call(obj) == '[object ' + name + ']';
    };
  });

  // Define a fallback version of the method in browsers (ahem, IE), where
  // there isn't any inspectable "Arguments" type.
  if (!_.isArguments(arguments)) {
    _.isArguments = function(obj) {
      return !!(obj && _.has(obj, 'callee'));
    };
  }

  // Optimize `isFunction` if appropriate.
  if (typeof (/./) !== 'function') {
    _.isFunction = function(obj) {
      return typeof obj === 'function';
    };
  }

  // Is a given object a finite number?
  _.isFinite = function(obj) {
    return isFinite(obj) && !isNaN(parseFloat(obj));
  };

  // Is the given value `NaN`? (NaN is the only number which does not equal itself).
  _.isNaN = function(obj) {
    return _.isNumber(obj) && obj != +obj;
  };

  // Is a given value a boolean?
  _.isBoolean = function(obj) {
    return obj === true || obj === false || toString.call(obj) == '[object Boolean]';
  };

  // Is a given value equal to null?
  _.isNull = function(obj) {
    return obj === null;
  };

  // Is a given variable undefined?
  _.isUndefined = function(obj) {
    return obj === void 0;
  };

  // Shortcut function for checking if an object has a given property directly
  // on itself (in other words, not on a prototype).
  _.has = function(obj, key) {
    return hasOwnProperty.call(obj, key);
  };

  // Utility Functions
  // -----------------

  // Run Underscore.js in *noConflict* mode, returning the `_` variable to its
  // previous owner. Returns a reference to the Underscore object.
  _.noConflict = function() {
    root._ = previousUnderscore;
    return this;
  };

  // Keep the identity function around for default iterators.
  _.identity = function(value) {
    return value;
  };

  // Run a function **n** times.
  _.times = function(n, iterator, context) {
    var accum = Array(Math.max(0, n));
    for (var i = 0; i < n; i++) accum[i] = iterator.call(context, i);
    return accum;
  };

  // Return a random integer between min and max (inclusive).
  _.random = function(min, max) {
    if (max == null) {
      max = min;
      min = 0;
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  };

  // List of HTML entities for escaping.
  var entityMap = {
    escape: {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;'
    }
  };
  entityMap.unescape = _.invert(entityMap.escape);

  // Regexes containing the keys and values listed immediately above.
  var entityRegexes = {
    escape:   new RegExp('[' + _.keys(entityMap.escape).join('') + ']', 'g'),
    unescape: new RegExp('(' + _.keys(entityMap.unescape).join('|') + ')', 'g')
  };

  // Functions for escaping and unescaping strings to/from HTML interpolation.
  _.each(['escape', 'unescape'], function(method) {
    _[method] = function(string) {
      if (string == null) return '';
      return ('' + string).replace(entityRegexes[method], function(match) {
        return entityMap[method][match];
      });
    };
  });

  // If the value of the named `property` is a function then invoke it with the
  // `object` as context; otherwise, return it.
  _.result = function(object, property) {
    if (object == null) return void 0;
    var value = object[property];
    return _.isFunction(value) ? value.call(object) : value;
  };

  // Add your own custom functions to the Underscore object.
  _.mixin = function(obj) {
    each(_.functions(obj), function(name) {
      var func = _[name] = obj[name];
      _.prototype[name] = function() {
        var args = [this._wrapped];
        push.apply(args, arguments);
        return result.call(this, func.apply(_, args));
      };
    });
  };

  // Generate a unique integer id (unique within the entire client session).
  // Useful for temporary DOM ids.
  var idCounter = 0;
  _.uniqueId = function(prefix) {
    var id = ++idCounter + '';
    return prefix ? prefix + id : id;
  };

  // By default, Underscore uses ERB-style template delimiters, change the
  // following template settings to use alternative delimiters.
  _.templateSettings = {
    evaluate    : /<%([\s\S]+?)%>/g,
    interpolate : /<%=([\s\S]+?)%>/g,
    escape      : /<%-([\s\S]+?)%>/g
  };

  // When customizing `templateSettings`, if you don't want to define an
  // interpolation, evaluation or escaping regex, we need one that is
  // guaranteed not to match.
  var noMatch = /(.)^/;

  // Certain characters need to be escaped so that they can be put into a
  // string literal.
  var escapes = {
    "'":      "'",
    '\\':     '\\',
    '\r':     'r',
    '\n':     'n',
    '\t':     't',
    '\u2028': 'u2028',
    '\u2029': 'u2029'
  };

  var escaper = /\\|'|\r|\n|\t|\u2028|\u2029/g;

  // JavaScript micro-templating, similar to John Resig's implementation.
  // Underscore templating handles arbitrary delimiters, preserves whitespace,
  // and correctly escapes quotes within interpolated code.
  _.template = function(text, data, settings) {
    var render;
    settings = _.defaults({}, settings, _.templateSettings);

    // Combine delimiters into one regular expression via alternation.
    var matcher = new RegExp([
      (settings.escape || noMatch).source,
      (settings.interpolate || noMatch).source,
      (settings.evaluate || noMatch).source
    ].join('|') + '|$', 'g');

    // Compile the template source, escaping string literals appropriately.
    var index = 0;
    var source = "__p+='";
    text.replace(matcher, function(match, escape, interpolate, evaluate, offset) {
      source += text.slice(index, offset)
        .replace(escaper, function(match) { return '\\' + escapes[match]; });

      if (escape) {
        source += "'+\n((__t=(" + escape + "))==null?'':_.escape(__t))+\n'";
      }
      if (interpolate) {
        source += "'+\n((__t=(" + interpolate + "))==null?'':__t)+\n'";
      }
      if (evaluate) {
        source += "';\n" + evaluate + "\n__p+='";
      }
      index = offset + match.length;
      return match;
    });
    source += "';\n";

    // If a variable is not specified, place data values in local scope.
    if (!settings.variable) source = 'with(obj||{}){\n' + source + '}\n';

    source = "var __t,__p='',__j=Array.prototype.join," +
      "print=function(){__p+=__j.call(arguments,'');};\n" +
      source + "return __p;\n";

    try {
      render = new Function(settings.variable || 'obj', '_', source);
    } catch (e) {
      e.source = source;
      throw e;
    }

    if (data) return render(data, _);
    var template = function(data) {
      return render.call(this, data, _);
    };

    // Provide the compiled function source as a convenience for precompilation.
    template.source = 'function(' + (settings.variable || 'obj') + '){\n' + source + '}';

    return template;
  };

  // Add a "chain" function, which will delegate to the wrapper.
  _.chain = function(obj) {
    return _(obj).chain();
  };

  // OOP
  // ---------------
  // If Underscore is called as a function, it returns a wrapped object that
  // can be used OO-style. This wrapper holds altered versions of all the
  // underscore functions. Wrapped objects may be chained.

  // Helper function to continue chaining intermediate results.
  var result = function(obj) {
    return this._chain ? _(obj).chain() : obj;
  };

  // Add all of the Underscore functions to the wrapper object.
  _.mixin(_);

  // Add all mutator Array functions to the wrapper.
  each(['pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      var obj = this._wrapped;
      method.apply(obj, arguments);
      if ((name == 'shift' || name == 'splice') && obj.length === 0) delete obj[0];
      return result.call(this, obj);
    };
  });

  // Add all accessor Array functions to the wrapper.
  each(['concat', 'join', 'slice'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      return result.call(this, method.apply(this._wrapped, arguments));
    };
  });

  _.extend(_.prototype, {

    // Start chaining a wrapped Underscore object.
    chain: function() {
      this._chain = true;
      return this;
    },

    // Extracts the result from a wrapped and chained object.
    value: function() {
      return this._wrapped;
    }

  });

}).call(this);

},{}],23:[function(require,module,exports){
// created by @HenrikJoreteg
var prefix;
var isChrome = false;
var isFirefox = false;
var ua = navigator.userAgent.toLowerCase();

// basic sniffing
if (ua.indexOf('firefox') !== -1) {
    prefix = 'moz';
    isFirefox = true;
} else if (ua.indexOf('chrome') !== -1) {
    prefix = 'webkit';
    isChrome = true;
}

var PC = window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
var IceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;
var SessionDescription = window.mozRTCSessionDescription || window.RTCSessionDescription;
var MediaStream = window.webkitMediaStream || window.MediaStream;
var screenSharing = navigator.userAgent.match('Chrome') && parseInt(navigator.userAgent.match(/Chrome\/(.*) /)[1], 10) >= 26;
var AudioContext = window.webkitAudioContext || window.AudioContext;


// export support flags and constructors.prototype && PC
module.exports = {
    support: !!PC,
    dataChannel: isChrome || isFirefox || (PC.prototype && PC.prototype.createDataChannel),
    prefix: prefix,
    webAudio: !!(AudioContext && AudioContext.prototype.createMediaStreamSource),
    mediaStream: !!(MediaStream && MediaStream.prototype.removeTrack),
    screenSharing: !!screenSharing,
    AudioContext: AudioContext,
    PeerConnection: PC,
    SessionDescription: SessionDescription,
    IceCandidate: IceCandidate
};

},{}],24:[function(require,module,exports){
/*
WildEmitter.js is a slim little event emitter by @henrikjoreteg largely based 
on @visionmedia's Emitter from UI Kit.

Why? I wanted it standalone.

I also wanted support for wildcard emitters like this:

emitter.on('*', function (eventName, other, event, payloads) {
    
});

emitter.on('somenamespace*', function (eventName, payloads) {
    
});

Please note that callbacks triggered by wildcard registered events also get 
the event name as the first argument.
*/
module.exports = WildEmitter;

function WildEmitter() {
    this.callbacks = {};
}

// Listen on the given `event` with `fn`. Store a group name if present.
WildEmitter.prototype.on = function (event, groupName, fn) {
    var hasGroup = (arguments.length === 3),
        group = hasGroup ? arguments[1] : undefined, 
        func = hasGroup ? arguments[2] : arguments[1];
    func._groupName = group;
    (this.callbacks[event] = this.callbacks[event] || []).push(func);
    return this;
};

// Adds an `event` listener that will be invoked a single
// time then automatically removed.
WildEmitter.prototype.once = function (event, groupName, fn) {
    var self = this,
        hasGroup = (arguments.length === 3),
        group = hasGroup ? arguments[1] : undefined, 
        func = hasGroup ? arguments[2] : arguments[1];
    function on() {
        self.off(event, on);
        func.apply(this, arguments);
    }
    this.on(event, group, on);
    return this;
};

// Unbinds an entire group
WildEmitter.prototype.releaseGroup = function (groupName) {
    var item, i, len, handlers;
    for (item in this.callbacks) {
        handlers = this.callbacks[item];
        for (i = 0, len = handlers.length; i < len; i++) {
            if (handlers[i]._groupName === groupName) {
                //console.log('removing');
                // remove it and shorten the array we're looping through
                handlers.splice(i, 1);
                i--;
                len--;
            }
        }
    }
    return this;
};

// Remove the given callback for `event` or all
// registered callbacks.
WildEmitter.prototype.off = function (event, fn) {
    var callbacks = this.callbacks[event],
        i;
    
    if (!callbacks) return this;

    // remove all handlers
    if (arguments.length === 1) {
        delete this.callbacks[event];
        return this;
    }

    // remove specific handler
    i = callbacks.indexOf(fn);
    callbacks.splice(i, 1);
    return this;
};

// Emit `event` with the given args.
// also calls any `*` handlers
WildEmitter.prototype.emit = function (event) {
    var args = [].slice.call(arguments, 1),
        callbacks = this.callbacks[event],
        specialCallbacks = this.getWildcardCallbacks(event),
        i,
        len,
        item;

    if (callbacks) {
        for (i = 0, len = callbacks.length; i < len; ++i) {
            if (callbacks[i]) {
                callbacks[i].apply(this, args);
            } else {
                break;
            }
        }
    }

    if (specialCallbacks) {
        for (i = 0, len = specialCallbacks.length; i < len; ++i) {
            if (specialCallbacks[i]) {
                specialCallbacks[i].apply(this, [event].concat(args));
            } else {
                break;
            }
        }
    }

    return this;
};

// Helper for for finding special wildcard event handlers that match the event
WildEmitter.prototype.getWildcardCallbacks = function (eventName) {
    var item,
        split,
        result = [];

    for (item in this.callbacks) {
        split = item.split('*');
        if (item === '*' || (split.length === 2 && eventName.slice(0, split[1].length) === split[1])) {
            result = result.concat(this.callbacks[item]);
        }
    }
    return result;
};

},{}]},{},[1])
//@ sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbWFpbi5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvYXR0YWNobWVkaWFzdHJlYW0vYXR0YWNobWVkaWFzdHJlYW0uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2luc2VydC1tb2R1bGUtZ2xvYmFscy9ub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvaW5kZXguanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9saWIvZ2VuZXJpY1Nlc3Npb24uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9saWIvbWVkaWFTZXNzaW9uLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbGliL3Nlc3Npb25NYW5hZ2VyLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL2FzeW5jL2xpYi9hc3luYy5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9ib3dzL2Jvd3MuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvYm93cy9ub2RlX21vZHVsZXMvYW5kbG9nL2FuZGxvZy5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9nZXR1c2VybWVkaWEvZ2V0dXNlcm1lZGlhLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL2hhcmsvaGFyay5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9qaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24vaW5kZXguanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvamluZ2xlLXJ0Y3BlZXJjb25uZWN0aW9uL25vZGVfbW9kdWxlcy9ydGNwZWVyY29ubmVjdGlvbi9ydGNwZWVyY29ubmVjdGlvbi5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9tZWRpYXN0cmVhbS1nYWluL21lZGlhc3RyZWFtLWdhaW4uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvbWVkaWFzdHJlYW0tZ2Fpbi9ub2RlX21vZHVsZXMvd2VicnRjc3VwcG9ydC93ZWJydGNzdXBwb3J0LmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL21vY2tjb25zb2xlL21vY2tjb25zb2xlLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL3NkcC1qaW5nbGUtanNvbi9pbmRleC5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9zZHAtamluZ2xlLWpzb24vbGliL3BhcnNlcnMuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvc2RwLWppbmdsZS1qc29uL2xpYi90b2pzb24uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvc2RwLWppbmdsZS1qc29uL2xpYi90b3NkcC5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy91bmRlcnNjb3JlL3VuZGVyc2NvcmUuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvd2VicnRjc3VwcG9ydC93ZWJydGNzdXBwb3J0LmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL3dpbGRlbWl0dGVyL3dpbGRlbWl0dGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JEQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDalZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMzdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcE1BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNU5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzV2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwic291cmNlc0NvbnRlbnQiOlsidmFyIEppbmdsZSA9IHJlcXVpcmUoJ2ppbmdsZScpXG4gICwgYXR0YWNoTWVkaWFTdHJlYW0gPSByZXF1aXJlKCdhdHRhY2htZWRpYXN0cmVhbScpXG5cbnZhciBzb2NrZXQgPSBuZXcgUHJpbXVzKCdodHRwczovL3htcHAtZnR3LmppdC5zdScpXG52YXIgamluZ2xlID0gbmV3IEppbmdsZSgpXG5cbnZhciBsb2dpbkluZm8gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW5JbmZvJylcbnZhciBsb2NhbFN0YXJ0ZWQgPSBmYWxzZVxuXG5sb2dpbkluZm8ub25zdWJtaXQgPSBmdW5jdGlvbiAoZSkge1xuICBpZiAoZS5wcmV2ZW50RGVmYXVsdCkgZS5wcmV2ZW50RGVmYXVsdCgpXG5cbiAgdmFyIGppZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqaWQnKS52YWx1ZVxuICB2YXIgdXNlcm5hbWUgPSBqaWQuc2xpY2UoMCwgamlkLmluZGV4T2YoJ0AnKSlcblxuICBjb25zb2xlLmxvZygnQ29ubmVjdGVkJylcbiAgc29ja2V0LnNlbmQoXG4gICAgJ3htcHAubG9naW4nLCB7XG4gICAgICAgIGppZDogamlkLFxuICAgICAgICBwYXNzd29yZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Bhc3N3b3JkJykudmFsdWUsXG4gICAgICAgIGhvc3Q6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdob3N0JykudmFsdWUsXG4gICAgICAgIHJlc291cmNlOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVzb3VyY2UnKS52YWx1ZSB8fCAnamluZ2xlLXJvY2tzJ1xuICAgIH1cbiAgKVxuICBzb2NrZXQub24oJ3htcHAuY29ubmVjdGlvbicsIGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBjb25zb2xlLmxvZygnY29ubmVjdGVkJywgZGF0YSlcbiAgICBzb2NrZXQuc2VuZCgneG1wcC5wcmVzZW5jZScsIHt9KVxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdteUpJRCcpLnRleHRDb250ZW50ID0gZGF0YS5qaWQudXNlciArXG4gICAgICAgICdAJyArIGRhdGEuamlkLmRvbWFpbiArICcvJyArIGRhdGEuamlkLnJlc291cmNlXG4gIH0pXG5cbiAgamluZ2xlLm9uKCdpbmNvbWluZycsIGZ1bmN0aW9uIChzZXNzaW9uKSB7XG4gICAgY29uc29sZS5sb2coJ2luY29taW5nIHNlc3Npb24nLCBzZXNzaW9uKVxuICAgIHNlc3Npb24uYWNjZXB0KClcbiAgfSlcbiAgamluZ2xlLm9uKCdwZWVyU3RyZWFtQWRkZWQnLCBmdW5jdGlvbihzZXNzaW9uKSB7XG4gICAgY29uc29sZS5sb2coJ3BlZXJTdHJlYW1BZGRlZCcsIHNlc3Npb24pXG4gICBhdHRhY2hNZWRpYVN0cmVhbShzZXNzaW9uLnN0cmVhbSwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlbW90ZVZpZGVvJykpXG4gIH0pXG4gIGppbmdsZS5vbignbG9jYWxTdHJlYW0nLCBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgaWYgKGZhbHNlID09PSBsb2NhbFN0YXJ0ZWQpIHtcbiAgICAgIGF0dGFjaE1lZGlhU3RyZWFtKHN0cmVhbSwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsVmlkZW8nKSwgeyBtdXRlZDogdHJ1ZSwgbWlycm9yOiB0cnVlIH0pXG4gICAgICBsb2NhbFN0YXJ0ZWQgPSB0cnVlXG4gICAgfVxuICB9KVxuICBqaW5nbGUub24oJ3NlbmQnLCBmdW5jdGlvbihkYXRhKSB7XG4gICAgaWYgKGRhdGEuamluZ2xlICYmIChkYXRhLmppbmdsZS5hY3Rpb24gPT0gJ3Nlc3Npb24tYWNjZXB0JykpIHtcbiAgICAgIGNvbnNvbGUuZGVidWcoJ3NlbmRpbmcnLCBkYXRhKVxuICAgICAgd2luZG93LmppbmdsZUFjY2VwdCA9IGRhdGFcbiAgICB9XG4gICAgc29ja2V0LnNlbmQoJ3htcHAuamluZ2xlLnJlcXVlc3QnLCBkYXRhLCBmdW5jdGlvbihlcnJvciwgc3VjY2Vzcykge1xuICAgICAgaWYgKGVycm9yKSByZXR1cm4gY29uc29sZS5lcnJvcignRmFpbGVkJywgZXJyb3IpXG4gICAgICBjb25zb2xlLmxvZyhkYXRhLmppbmdsZS5hY3Rpb24gKyAnIGFjaycsIHN1Y2Nlc3MpXG4gICAgfSlcbiAgfSlcblxuICB2YXIgY2FsbEluZm8gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2FsbEluZm8nKVxuICBjYWxsSW5mby5vbnN1Ym1pdCA9IGZ1bmN0aW9uIChlKSB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpXG4gICAgdmFyIGppZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwZWVyJykudmFsdWVcbiAgICBqaW5nbGUuc3RhcnRMb2NhbE1lZGlhKG51bGwsIGZ1bmN0aW9uIChlcnJvciwgc3RyZWFtKSB7XG4gICAgICBsb2NhbFN0YXJ0ZWQgPSB0cnVlXG4gICAgICB2YXIgc2VzcyA9IGppbmdsZS5jcmVhdGVNZWRpYVNlc3Npb24oamlkKVxuICAgICAgc2Vzcy5zdGFydCgpXG4gICAgICBjb25zb2xlLmxvZygnQ2FsbGluZyAnICsgamlkKVxuICAgIH0pXG4gICAgcmV0dXJuIGZhbHNlXG4gIH1cbiAgcmV0dXJuIGZhbHNlXG59XG5cbnNvY2tldC5vbigneG1wcC5lcnJvci5jbGllbnQnLCBmdW5jdGlvbihlcnJvcikge1xuICBjb25zb2xlLmVycm9yKGVycm9yKVxufSlcblxuamluZ2xlLnN0YXJ0TG9jYWxNZWRpYShudWxsLCBmdW5jdGlvbiAoZXJyb3IsIHN0cmVhbSkge1xuICBpZiAoZXJyb3IpIHJldHVybiBjb25zb2xlLmVycm9yKGVycm9yKVxuICBhdHRhY2hNZWRpYVN0cmVhbShzdHJlYW0sIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbFZpZGVvJyksIHsgbXV0ZWQ6IHRydWUsIG1pcnJvcjogdHJ1ZSB9KVxuICBsb2NhbFN0YXJ0ZWQgPSB0cnVlXG59KVxuXG5zb2NrZXQub24oJ3htcHAuamluZ2xlLnJlcXVlc3QnLCBmdW5jdGlvbihkYXRhKSB7XG4gIGlmIChmYWxzZSA9PT0gbG9jYWxTdGFydGVkKSB7XG4gICAgamluZ2xlLnN0YXJ0TG9jYWxNZWRpYShudWxsLCBmdW5jdGlvbiAoZXJyb3IsIHN0cmVhbSkge1xuICAgICAgaWYgKGVycm9yKSByZXR1cm4gY29uc29sZS5lcnJvcihlcnJvcilcbiAgICAgIGF0dGFjaE1lZGlhU3RyZWFtKHN0cmVhbSwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY2FsVmlkZW8nKSwgeyBtdXRlZDogdHJ1ZSwgbWlycm9yOiB0cnVlIH0pXG4gICAgfSlcbiAgICBsb2NhbFN0YXJ0ZWQgPSB0cnVlXG4gIH1cbiAgamluZ2xlLnByb2Nlc3MoZGF0YSlcbn0pXG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChzdHJlYW0sIGVsLCBvcHRpb25zKSB7XG4gICAgdmFyIFVSTCA9IHdpbmRvdy5VUkw7XG4gICAgdmFyIG9wdHMgPSB7XG4gICAgICAgIGF1dG9wbGF5OiB0cnVlLFxuICAgICAgICBtaXJyb3I6IGZhbHNlLFxuICAgICAgICBtdXRlZDogZmFsc2VcbiAgICB9O1xuICAgIHZhciBlbGVtZW50ID0gZWwgfHwgZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndmlkZW8nKTtcbiAgICB2YXIgaXRlbTtcblxuICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgIGZvciAoaXRlbSBpbiBvcHRpb25zKSB7XG4gICAgICAgICAgICBvcHRzW2l0ZW1dID0gb3B0aW9uc1tpdGVtXTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlmIChvcHRzLmF1dG9wbGF5KSBlbGVtZW50LmF1dG9wbGF5ID0gJ2F1dG9wbGF5JztcbiAgICBpZiAob3B0cy5tdXRlZCkgZWxlbWVudC5tdXRlZCA9IHRydWU7XG4gICAgaWYgKG9wdHMubWlycm9yKSB7XG4gICAgICAgIFsnJywgJ21veicsICd3ZWJraXQnLCAnbycsICdtcyddLmZvckVhY2goZnVuY3Rpb24gKHByZWZpeCkge1xuICAgICAgICAgICAgdmFyIHN0eWxlTmFtZSA9IHByZWZpeCA/IHByZWZpeCArICdUcmFuc2Zvcm0nIDogJ3RyYW5zZm9ybSc7XG4gICAgICAgICAgICBlbGVtZW50LnN0eWxlW3N0eWxlTmFtZV0gPSAnc2NhbGVYKC0xKSc7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIHRoaXMgZmlyc3Qgb25lIHNob3VsZCB3b3JrIG1vc3QgZXZlcnl3aGVyZSBub3dcbiAgICAvLyBidXQgd2UgaGF2ZSBhIGZldyBmYWxsYmFja3MganVzdCBpbiBjYXNlLlxuICAgIGlmIChVUkwgJiYgVVJMLmNyZWF0ZU9iamVjdFVSTCkge1xuICAgICAgICBlbGVtZW50LnNyYyA9IFVSTC5jcmVhdGVPYmplY3RVUkwoc3RyZWFtKTtcbiAgICB9IGVsc2UgaWYgKGVsZW1lbnQuc3JjT2JqZWN0KSB7XG4gICAgICAgIGVsZW1lbnQuc3JjT2JqZWN0ID0gc3RyZWFtO1xuICAgIH0gZWxzZSBpZiAoZWxlbWVudC5tb3pTcmNPYmplY3QpIHtcbiAgICAgICAgZWxlbWVudC5tb3pTcmNPYmplY3QgPSBzdHJlYW07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiBlbGVtZW50O1xufTtcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxuXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG5cbnByb2Nlc3MubmV4dFRpY2sgPSAoZnVuY3Rpb24gKCkge1xuICAgIHZhciBjYW5TZXRJbW1lZGlhdGUgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5zZXRJbW1lZGlhdGU7XG4gICAgdmFyIGNhblBvc3QgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5wb3N0TWVzc2FnZSAmJiB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lclxuICAgIDtcblxuICAgIGlmIChjYW5TZXRJbW1lZGlhdGUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIChmKSB7IHJldHVybiB3aW5kb3cuc2V0SW1tZWRpYXRlKGYpIH07XG4gICAgfVxuXG4gICAgaWYgKGNhblBvc3QpIHtcbiAgICAgICAgdmFyIHF1ZXVlID0gW107XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgZnVuY3Rpb24gKGV2KSB7XG4gICAgICAgICAgICB2YXIgc291cmNlID0gZXYuc291cmNlO1xuICAgICAgICAgICAgaWYgKChzb3VyY2UgPT09IHdpbmRvdyB8fCBzb3VyY2UgPT09IG51bGwpICYmIGV2LmRhdGEgPT09ICdwcm9jZXNzLXRpY2snKSB7XG4gICAgICAgICAgICAgICAgZXYuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZuID0gcXVldWUuc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHRydWUpO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgICAgICB3aW5kb3cucG9zdE1lc3NhZ2UoJ3Byb2Nlc3MtdGljaycsICcqJyk7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZm4sIDApO1xuICAgIH07XG59KSgpO1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbiIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9saWIvc2Vzc2lvbk1hbmFnZXInKTtcbiIsInZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIGFzeW5jID0gcmVxdWlyZSgnYXN5bmMnKTtcbnZhciBXaWxkRW1pdHRlciA9IHJlcXVpcmUoJ3dpbGRlbWl0dGVyJyk7XG52YXIgSmluZ2xlUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdqaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24nKTtcbnZhciBKaW5nbGVKU09OID0gcmVxdWlyZSgnc2RwLWppbmdsZS1qc29uJyk7XG5cblxudmFyIGxvZyA9IGJvd3MoJ0ppbmdsZVNlc3Npb24nKTtcblxuXG5mdW5jdGlvbiBhY3Rpb25Ub01ldGhvZChhY3Rpb24pIHtcbiAgICB2YXIgd29yZHMgPSBhY3Rpb24uc3BsaXQoJy0nKTtcbiAgICByZXR1cm4gJ29uJyArIHdvcmRzWzBdWzBdLnRvVXBwZXJDYXNlKCkgKyB3b3Jkc1swXS5zdWJzdHIoMSkgKyB3b3Jkc1sxXVswXS50b1VwcGVyQ2FzZSgpICsgd29yZHNbMV0uc3Vic3RyKDEpO1xufVxuXG5cbmZ1bmN0aW9uIEppbmdsZVNlc3Npb24ob3B0cykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLnNpZCA9IG9wdHMuc2lkIHx8IERhdGUubm93KCkudG9TdHJpbmcoKTtcbiAgICB0aGlzLnBlZXIgPSBvcHRzLnBlZXI7XG4gICAgdGhpcy5pc0luaXRpYXRvciA9IG9wdHMuaW5pdGlhdG9yIHx8IGZhbHNlO1xuICAgIHRoaXMuc3RhdGUgPSAnc3RhcnRpbmcnO1xuICAgIHRoaXMucGFyZW50ID0gb3B0cy5wYXJlbnQ7XG5cbiAgICB0aGlzLnByb2Nlc3NpbmdRdWV1ZSA9IGFzeW5jLnF1ZXVlKGZ1bmN0aW9uICh0YXNrLCBuZXh0KSB7XG4gICAgICAgIHZhciBhY3Rpb24gID0gdGFzay5hY3Rpb247XG4gICAgICAgIHZhciBjaGFuZ2VzID0gdGFzay5jaGFuZ2VzO1xuICAgICAgICB2YXIgY2IgPSB0YXNrLmNiO1xuXG4gICAgICAgIGxvZyhzZWxmLnNpZCArICc6ICcgKyBhY3Rpb24pO1xuICAgICAgICBzZWxmW2FjdGlvbl0oY2hhbmdlcywgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgY2IoZXJyKTtcbiAgICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG59XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShXaWxkRW1pdHRlci5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogSmluZ2xlU2Vzc2lvblxuICAgIH1cbn0pO1xuXG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnByb2Nlc3MgPSBmdW5jdGlvbiAoYWN0aW9uLCBjaGFuZ2VzLCBjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHZhciBtZXRob2QgPSBhY3Rpb25Ub01ldGhvZChhY3Rpb24pO1xuXG4gICAgdGhpcy5wcm9jZXNzaW5nUXVldWUucHVzaCh7XG4gICAgICAgIGFjdGlvbjogbWV0aG9kLFxuICAgICAgICBjaGFuZ2VzOiBjaGFuZ2VzLFxuICAgICAgICBjYjogY2JcbiAgICB9KTtcbn07XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAodHlwZSwgZGF0YSkge1xuICAgIGRhdGEgPSBkYXRhIHx8IHt9O1xuICAgIGRhdGEuc2lkID0gdGhpcy5zaWQ7XG4gICAgZGF0YS5hY3Rpb24gPSB0eXBlO1xuICAgIHRoaXMucGFyZW50LmVtaXQoJ3NlbmQnLCB7XG4gICAgICAgIHRvOiB0aGlzLnBlZXIsXG4gICAgICAgIHR5cGU6ICdzZXQnLFxuICAgICAgICBqaW5nbGU6IGRhdGFcbiAgICB9KTtcbn07XG5cbk9iamVjdC5kZWZpbmVQcm9wZXJ0eShKaW5nbGVTZXNzaW9uLnByb3RvdHlwZSwgJ3N0YXRlJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGU7XG4gICAgfSxcbiAgICBzZXQ6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICB2YXIgdmFsaWRTdGF0ZXMgPSB7XG4gICAgICAgICAgICBzdGFydGluZzogdHJ1ZSxcbiAgICAgICAgICAgIHBlbmRpbmc6IHRydWUsXG4gICAgICAgICAgICBhY3RpdmU6IHRydWUsXG4gICAgICAgICAgICBlbmRlZDogdHJ1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIGlmICghdmFsaWRTdGF0ZXNbdmFsdWVdKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgSmluZ2xlIFNlc3Npb24gU3RhdGU6ICcgKyB2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5fc3RhdGUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICB0aGlzLl9zdGF0ZSA9IHZhbHVlO1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogU3RhdGUgY2hhbmdlZCB0byAnICsgdmFsdWUpO1xuICAgICAgICB9XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdzdGFydGluZycsIHtcbiAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3N0YXRlID09ICdzdGFydGluZyc7XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdwZW5kaW5nJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGUgPT0gJ3BlbmRpbmcnO1xuICAgIH1cbn0pO1xuT2JqZWN0LmRlZmluZVByb3BlcnR5KEppbmdsZVNlc3Npb24ucHJvdG90eXBlLCAnYWN0aXZlJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGUgPT0gJ2FjdGl2ZSc7XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdlbmRlZCcsIHtcbiAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3N0YXRlID09ICdlbmRlZCc7XG4gICAgfVxufSk7XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnN0YXJ0ID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuc3RhdGUgPSAncGVuZGluZyc7XG4gICAgbG9nKHRoaXMuc2lkICsgJzogQ2FuIG5vdCBzdGFydCBnZW5lcmljIHNlc3Npb24nKTtcbn07XG5KaW5nbGVTZXNzaW9uLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAocmVhc29uLCBzaWxlbmNlKSB7XG4gICAgdGhpcy5wYXJlbnQucGVlcnNbdGhpcy5wZWVyXS5zcGxpY2UodGhpcy5wYXJlbnQucGVlcnNbdGhpcy5wZWVyXS5pbmRleE9mKHRoaXMpLCAxKTtcbiAgICBkZWxldGUgdGhpcy5wYXJlbnQuc2Vzc2lvbnNbdGhpcy5zaWRdO1xuXG4gICAgdGhpcy5zdGF0ZSA9ICdlbmRlZCc7XG5cbiAgICByZWFzb24gPSByZWFzb24gfHwge307XG5cbiAgICBpZiAoIXNpbGVuY2UpIHtcbiAgICAgICAgdGhpcy5zZW5kKCdzZXNzaW9uLXRlcm1pbmF0ZScsIHtyZWFzb246IHJlYXNvbn0pO1xuICAgIH1cblxuICAgIHRoaXMucGFyZW50LmVtaXQoJ3Rlcm1pbmF0ZWQnLCB0aGlzLCByZWFzb24pO1xufTtcblxudmFyIGFjdGlvbnMgPSBbXG4gICAgJ2NvbnRlbnQtYWNjZXB0JywgJ2NvbnRlbnQtYWRkJywgJ2NvbnRlbnQtbW9kaWZ5JyxcbiAgICAnY29uZW50LXJlamVjdCcsICdjb250ZW50LXJlbW92ZScsICdkZXNjcmlwdGlvbi1pbmZvJyxcbiAgICAnc2Vzc2lvbi1hY2NlcHQnLCAnc2Vzc2lvbi1pbmZvJywgJ3Nlc3Npb24taW5pdGlhdGUnLFxuICAgICdzZXNzaW9uLXRlcm1pbmF0ZScsICd0cmFuc3BvcnQtYWNjZXB0JywgJ3RyYW5zcG9ydC1pbmZvJyxcbiAgICAndHJhbnNwb3J0LXJlamVjdCcsICd0cmFuc3BvcnQtcmVwbGFjZSdcbl07XG5cbmFjdGlvbnMuZm9yRWFjaChmdW5jdGlvbiAoYWN0aW9uKSB7XG4gICAgdmFyIG1ldGhvZCA9IGFjdGlvblRvTWV0aG9kKGFjdGlvbik7XG4gICAgSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uIChjaGFuZ2VzLCBjYikge1xuICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBVbnN1cHBvcnRlZCBhY3Rpb24gJyArIGFjdGlvbik7XG4gICAgICAgIGNiKCk7XG4gICAgfTtcbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEppbmdsZVNlc3Npb247XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIEppbmdsZVNlc3Npb24gPSByZXF1aXJlKCcuL2dlbmVyaWNTZXNzaW9uJyk7XG52YXIgSmluZ2xlUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdqaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24nKTtcblxuXG52YXIgbG9nID0gYm93cygnSmluZ2xlTWVkaWEnKTtcblxuXG5mdW5jdGlvbiBNZWRpYVNlc3Npb24ob3B0cykge1xuICAgIEppbmdsZVNlc3Npb24uY2FsbCh0aGlzLCBvcHRzKTtcblxuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHRoaXMucGMgPSBuZXcgSmluZ2xlUGVlckNvbm5lY3Rpb24odGhpcy5wYXJlbnQuY29uZmlnLnBlZXJDb25uZWN0aW9uQ29uZmlnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wYXJlbnQuY29uZmlnLnBlZXJDb25uZWN0aW9uQ29uc3RyYWludHMpO1xuICAgIHRoaXMucGMub24oJ2ljZScsIHRoaXMub25JY2VDYW5kaWRhdGUuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5wYy5vbignYWRkU3RyZWFtJywgdGhpcy5vblN0cmVhbUFkZGVkLmJpbmQodGhpcykpO1xuICAgIHRoaXMucGMub24oJ3JlbW92ZVN0cmVhbScsIHRoaXMub25TdHJlYW1SZW1vdmVkLmJpbmQodGhpcykpO1xuICAgIHRoaXMucGVuZGluZ0Fuc3dlciA9IG51bGw7XG5cbiAgICBpZiAodGhpcy5wYXJlbnQubG9jYWxTdHJlYW0pIHtcbiAgICAgICAgdGhpcy5wYy5hZGRTdHJlYW0odGhpcy5wYXJlbnQubG9jYWxTdHJlYW0pO1xuICAgICAgICB0aGlzLmxvY2FsU3RyZWFtID0gdGhpcy5wYXJlbnQubG9jYWxTdHJlYW07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5wYXJlbnQub25jZSgnbG9jYWxTdHJlYW0nLCBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgICAgICAgICBzZWxmLnBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgICAgICAgICAgdGhpcy5sb2NhbFN0cmVhbSA9IHN0cmVhbTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5zdHJlYW0gPSBudWxsO1xufVxuXG5NZWRpYVNlc3Npb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShKaW5nbGVTZXNzaW9uLnByb3RvdHlwZSwge1xuICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBNZWRpYVNlc3Npb25cbiAgICB9XG59KTtcblxuTWVkaWFTZXNzaW9uLnByb3RvdHlwZSA9IF8uZXh0ZW5kKE1lZGlhU2Vzc2lvbi5wcm90b3R5cGUsIHtcbiAgICBzdGFydDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAncGVuZGluZyc7XG4gICAgICAgIHRoaXMucGMuaXNJbml0aWF0b3IgPSB0cnVlO1xuICAgICAgICB0aGlzLnBjLm9mZmVyKGZ1bmN0aW9uIChlcnIsIHNlc3NEZXNjKSB7XG4gICAgICAgICAgICBzZWxmLnNlbmQoJ3Nlc3Npb24taW5pdGlhdGUnLCBzZXNzRGVzYy5qc29uKTtcbiAgICAgICAgfSk7XG4gICAgfSxcbiAgICBlbmQ6IGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgICAgdGhpcy5wYy5jbG9zZSgpO1xuICAgICAgICB0aGlzLm9uU3RyZWFtUmVtb3ZlZCgpO1xuICAgICAgICBKaW5nbGVTZXNzaW9uLnByb3RvdHlwZS5lbmQuY2FsbCh0aGlzLCByZWFzb24pO1xuICAgIH0sXG4gICAgYWNjZXB0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGxvZyh0aGlzLnNpZCArICc6IEFjY2VwdGVkIGluY29taW5nIHNlc3Npb24nKTtcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdhY3RpdmUnO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24tYWNjZXB0JywgdGhpcy5wZW5kaW5nQW5zd2VyKTtcbiAgICB9LFxuICAgIHJpbmc6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmluZ2luZyBvbiBpbmNvbWluZyBzZXNzaW9uJyk7XG4gICAgICAgIHRoaXMuc2VuZCgnc2Vzc2lvbi1pbmZvJywge3Jpbmdpbmc6IHRydWV9KTtcbiAgICB9LFxuICAgIG11dGU6IGZ1bmN0aW9uIChjcmVhdG9yLCBuYW1lKSB7XG4gICAgICAgIGxvZyh0aGlzLnNpZCArICc6IE11dGluZycpO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24taW5mbycsIHttdXRlOiB7Y3JlYXRvcjogY3JlYXRvciwgbmFtZTogbmFtZX19KTtcbiAgICB9LFxuICAgIHVubXV0ZTogZnVuY3Rpb24gKGNyZWF0b3IsIG5hbWUpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVW5tdXRpbmcnKTtcbiAgICAgICAgdGhpcy5zZW5kKCdzZXNzaW9uLWluZm8nLCB7dW5tdXRlOiB7Y3JlYXRvcjogY3JlYXRvciwgbmFtZTogbmFtZX19KTtcbiAgICB9LFxuICAgIGhvbGQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUGxhY2luZyBvbiBob2xkJyk7XG4gICAgICAgIHRoaXMuc2VuZCgnc2Vzc2lvbi1pbmZvJywge2hvbGQ6IHRydWV9KTtcbiAgICB9LFxuICAgIHJlc3VtZTogZnVuY3Rpb24gKCkge1xuICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZXN1aW5nIGZyb20gaG9sZCcpO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24taW5mbycsIHthY3RpdmU6IHRydWV9KTtcbiAgICB9LFxuICAgIG9uU2Vzc2lvbkluaXRpYXRlOiBmdW5jdGlvbiAoY2hhbmdlcywgY2IpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogSW5pdGlhdGluZyBpbmNvbWluZyBzZXNzaW9uJyk7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdwZW5kaW5nJztcbiAgICAgICAgdGhpcy5wYy5pc0luaXRpYXRvciA9IGZhbHNlO1xuICAgICAgICB0aGlzLnBjLmFuc3dlcih7dHlwZTogJ29mZmVyJywganNvbjogY2hhbmdlc30sIGZ1bmN0aW9uIChlcnIsIGFuc3dlcikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIGxvZyhzZWxmLnNpZCArICc6IENvdWxkIG5vdCBjcmVhdGUgV2ViUlRDIGFuc3dlcicsIGVycik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNiKHtjb25kaXRpb246ICdnZW5lcmFsLWVycm9yJ30pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2VsZi5wZW5kaW5nQW5zd2VyID0gYW5zd2VyLmpzb247XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICB9KTtcbiAgICB9LFxuICAgIG9uU2Vzc2lvbkFjY2VwdDogZnVuY3Rpb24gKGNoYW5nZXMsIGNiKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogQWN0aXZhdGluZyBhY2NlcHRlZCBvdXRib3VuZCBzZXNzaW9uJyk7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAnYWN0aXZlJztcbiAgICAgICAgdGhpcy5wYy5oYW5kbGVBbnN3ZXIoe3R5cGU6ICdhbnN3ZXInLCBqc29uOiBjaGFuZ2VzfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIGxvZyhzZWxmLnNpZCArICc6IENvdWxkIG5vdCBwcm9jZXNzIFdlYlJUQyBhbnN3ZXInLCBlcnIpO1xuICAgICAgICAgICAgICAgIHJldHVybiBjYih7Y29uZGl0aW9uOiAnZ2VuZXJhbC1lcnJvcid9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc2VsZi5wYXJlbnQuZW1pdCgnYWNjZXB0ZWQnLCBzZWxmKTtcbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gICAgb25TZXNzaW9uVGVybWluYXRlOiBmdW5jdGlvbiAoY2hhbmdlcywgY2IpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVGVybWluYXRpbmcgc2Vzc2lvbicpO1xuICAgICAgICB0aGlzLnBjLmNsb3NlKCk7XG4gICAgICAgIHRoaXMub25TdHJlYW1SZW1vdmVkKCk7XG4gICAgICAgIEppbmdsZVNlc3Npb24ucHJvdG90eXBlLmVuZC5jYWxsKHRoaXMsIGNoYW5nZXMucmVhc29uLCB0cnVlKTtcbiAgICAgICAgY2IoKTtcbiAgICB9LFxuICAgIG9uVHJhbnNwb3J0SW5mbzogZnVuY3Rpb24gKGNoYW5nZXMsIGNiKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogQWRkaW5nIElDRSBjYW5kaWRhdGUnKTtcbiAgICAgICAgdGhpcy5wYy5wcm9jZXNzSWNlKGNoYW5nZXMsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBsb2coc2VsZi5zaWQgKyAnOiBDb3VsZCBub3QgcHJvY2VzcyBJQ0UgY2FuZGlkYXRlJywgZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gICAgb25TZXNzaW9uSW5mbzogZnVuY3Rpb24gKGluZm8sIGNiKSB7XG4gICAgICAgIGxvZyhpbmZvKTtcbiAgICAgICAgaWYgKGluZm8ucmluZ2luZykge1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmluZ2luZyBvbiByZW1vdGUgc3RyZWFtJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdyaW5naW5nJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5ob2xkKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBPbiBob2xkJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdob2xkJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hY3RpdmUpIHtcbiAgICAgICAgICAgIGxvZyh0aGlzLnNpZCArICc6IFJlc3VtZWQgZnJvbSBob2xkJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdyZXN1bWVkJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5tdXRlKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBNdXRlZCcsIGluZm8ubXV0ZSk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdtdXRlJywgdGhpcywgaW5mby5tdXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVubXV0ZSkge1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVW5tdXRlZCcsIGluZm8udW5tdXRlKTtcbiAgICAgICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3VubXV0ZScsIHRoaXMsIGluZm8udW5tdXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNiKCk7XG4gICAgfSxcbiAgICBvbkljZUNhbmRpZGF0ZTogZnVuY3Rpb24gKGNhbmRpZGF0ZUluZm8pIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogRGlzY292ZXJlZCBuZXcgSUNFIGNhbmRpZGF0ZScsIGNhbmRpZGF0ZUluZm8pO1xuICAgICAgICB0aGlzLnNlbmQoJ3RyYW5zcG9ydC1pbmZvJywgY2FuZGlkYXRlSW5mbyk7XG4gICAgfSxcbiAgICBvblN0cmVhbUFkZGVkOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgaWYgKHRoaXMuc3RyZWFtKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZWNlaXZlZCByZW1vdGUgc3RyZWFtLCBidXQgb25lIGFscmVhZHkgZXhpc3RzJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZW1vdGUgbWVkaWEgc3RyZWFtIGFkZGVkJyk7XG4gICAgICAgICAgICB0aGlzLnN0cmVhbSA9IGV2ZW50LnN0cmVhbTtcbiAgICAgICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3BlZXJTdHJlYW1BZGRlZCcsIHRoaXMpO1xuICAgICAgICB9XG4gICAgfSxcbiAgICBvblN0cmVhbVJlbW92ZWQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmVtb3RlIG1lZGlhIHN0cmVhbSByZW1vdmVkJyk7XG4gICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3BlZXJTdHJlYW1SZW1vdmVkJywgdGhpcyk7XG4gICAgfVxufSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBNZWRpYVNlc3Npb247XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIGhhcmsgPSByZXF1aXJlKCdoYXJrJyk7XG52YXIgd2VicnRjID0gcmVxdWlyZSgnd2VicnRjc3VwcG9ydCcpO1xudmFyIG1vY2tjb25zb2xlID0gcmVxdWlyZSgnbW9ja2NvbnNvbGUnKTtcbnZhciBnZXRVc2VyTWVkaWEgPSByZXF1aXJlKCdnZXR1c2VybWVkaWEnKTtcbnZhciBKaW5nbGVQZWVyQ29ubmVjdGlvbiA9IHJlcXVpcmUoJ2ppbmdsZS1ydGNwZWVyY29ubmVjdGlvbicpO1xudmFyIFdpbGRFbWl0dGVyID0gcmVxdWlyZSgnd2lsZGVtaXR0ZXInKTtcbnZhciBHYWluQ29udHJvbGxlciA9IHJlcXVpcmUoJ21lZGlhc3RyZWFtLWdhaW4nKTtcblxudmFyIEdlbmVyaWNTZXNzaW9uID0gcmVxdWlyZSgnLi9nZW5lcmljU2Vzc2lvbicpO1xudmFyIE1lZGlhU2Vzc2lvbiA9IHJlcXVpcmUoJy4vbWVkaWFTZXNzaW9uJyk7XG5cblxudmFyIGxvZyA9IGJvd3MoJ0ppbmdsZScpO1xuXG5cbmZ1bmN0aW9uIEppbmdsZShvcHRzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIHZhciBjb25maWcgPSB0aGlzLmNvbmZpZyA9IHtcbiAgICAgICAgZGVidWc6IGZhbHNlLFxuICAgICAgICBwZWVyQ29ubmVjdGlvbkNvbmZpZzoge1xuICAgICAgICAgICAgaWNlU2VydmVyczogW3tcInVybFwiOiBcInN0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDJcIn1dXG4gICAgICAgIH0sXG4gICAgICAgIHBlZXJDb25uZWN0aW9uQ29uc3RyYWludHM6IHtcbiAgICAgICAgICAgIG9wdGlvbmFsOiBbXG4gICAgICAgICAgICAgICAge0R0bHNTcnRwS2V5QWdyZWVtZW50OiB0cnVlfSxcbiAgICAgICAgICAgICAgICB7UnRwRGF0YUNoYW5uZWxzOiBmYWxzZX1cbiAgICAgICAgICAgIF1cbiAgICAgICAgfSxcbiAgICAgICAgYXV0b0FkanVzdE1pYzogZmFsc2UsXG4gICAgICAgIG1lZGlhOiB7XG4gICAgICAgICAgICBhdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgIHZpZGVvOiB0cnVlXG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdGhpcy5NZWRpYVNlc3Npb24gPSBNZWRpYVNlc3Npb247XG4gICAgdGhpcy5qaWQgPSBvcHRzLmppZDtcbiAgICB0aGlzLnNlc3Npb25zID0ge307XG4gICAgdGhpcy5wZWVycyA9IHt9O1xuXG4gICAgdGhpcy5zY3JlZW5TaGFyaW5nU3VwcG9ydCA9IHdlYnJ0Yy5zY3JlZW5TaGFyaW5nO1xuXG4gICAgZm9yICh2YXIgaXRlbSBpbiBvcHRzKSB7XG4gICAgICAgIGNvbmZpZ1tpdGVtXSA9IG9wdHNbaXRlbV07XG4gICAgfVxuXG4gICAgdGhpcy5jYXBhYmlsaXRpZXMgPSBbXG4gICAgICAgICd1cm46eG1wcDpqaW5nbGU6MSdcbiAgICBdO1xuICAgIGlmICh3ZWJydGMuc3VwcG9ydCkge1xuICAgICAgICB0aGlzLmNhcGFiaWxpdGllcyA9IFtcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6MScsXG4gICAgICAgICAgICAndXJuOnhtcHA6amluZ2xlOmFwcHM6cnRwOjEnLFxuICAgICAgICAgICAgJ3Vybjp4bXBwOmppbmdsZTphcHBzOnJ0cDphdWRpbycsXG4gICAgICAgICAgICAndXJuOnhtcHA6amluZ2xlOmFwcHM6cnRwOnZpZGVvJyxcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6YXBwczpydHA6cnRjYi1mYjowJyxcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6YXBwczpydHA6cnRwLWhkcmV4dDowJyxcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6YXBwczpkdGxzOjAnLFxuICAgICAgICAgICAgJ3Vybjp4bXBwOmppbmdsZTp0cmFuc3BvcnRzOmljZS11ZHA6MScsXG4gICAgICAgICAgICAndXJuOmlldGY6cmZjOjMyNjQnXG4gICAgICAgIF07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbG9nKCdXZWJSVEMgbm90IHN1cHBvcnRlZCcpO1xuICAgIH1cblxuICAgIFdpbGRFbWl0dGVyLmNhbGwodGhpcyk7XG5cbiAgICBpZiAodGhpcy5jb25maWcuZGVidWcpIHtcbiAgICAgICAgdGhpcy5vbignKicsIGZ1bmN0aW9uIChldmVudCwgdmFsMSwgdmFsMikge1xuICAgICAgICAgICAgbG9nKGV2ZW50LCB2YWwxLCB2YWwyKTtcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5KaW5nbGUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShXaWxkRW1pdHRlci5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogSmluZ2xlXG4gICAgfVxufSk7XG5cbkppbmdsZS5wcm90b3R5cGUuYWRkSUNFU2VydmVyID0gZnVuY3Rpb24gKHNlcnZlcikge1xuICAgIHRoaXMuY29uZmlnLnBlZXJDb25uZWN0aW9uQ29uZmlnLmljZVNlcnZlcnMucHVzaChzZXJ2ZXIpO1xufTtcblxuSmluZ2xlLnByb3RvdHlwZS5zdGFydExvY2FsTWVkaWEgPSBmdW5jdGlvbiAobWVkaWFDb25zdHJhaW50cywgY2IpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIGNvbnN0cmFpbnRzID0gbWVkaWFDb25zdHJhaW50cyB8fCB7dmlkZW86IHRydWUsIGF1ZGlvOiB0cnVlfTtcblxuICAgIGdldFVzZXJNZWRpYShjb25zdHJhaW50cywgZnVuY3Rpb24gKGVyciwgc3RyZWFtKSB7XG4gICAgICAgIGlmICghZXJyKSB7XG4gICAgICAgICAgICBpZiAoY29uc3RyYWludHMuYXVkaW8gJiYgc2VsZi5jb25maWcuZGV0ZWN0U3BlYWtpbmdFdmVudHMpIHtcbiAgICAgICAgICAgICAgICBzZWxmLnNldHVwQXVkaW9Nb25pdG9yKHN0cmVhbSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZWxmLmxvY2FsU3RyZWFtID0gc3RyZWFtO1xuXG4gICAgICAgICAgICBpZiAoc2VsZi5jb25maWcuYXV0b0FkanVzdE1pYykge1xuICAgICAgICAgICAgICAgIHNlbGYuZ2FpbkNvbnRyb2xsZXIgPSBuZXcgR2FpbkNvbnRyb2xsZXIoc3RyZWFtKTtcbiAgICAgICAgICAgICAgICBzZWxmLnNldE1pY0lmRW5hYmxlZCgwLjUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsb2coJ0xvY2FsIG1lZGlhIHN0cmVhbSBzdGFydGVkJyk7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ2xvY2FsU3RyZWFtJywgc3RyZWFtKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxvZygnQ291bGQgbm90IHN0YXJ0IGxvY2FsIG1lZGlhJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNiKSBjYihlcnIsIHN0cmVhbSk7XG4gICAgfSk7XG59O1xuXG5KaW5nbGUucHJvdG90eXBlLnN0b3BMb2NhbE1lZGlhID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh0aGlzLmxvY2FsU3RyZWFtKSB7XG4gICAgICAgIHRoaXMubG9jYWxTdHJlYW0uc3RvcCgpO1xuICAgICAgICB0aGlzLmVtaXQoJ2xvY2FsU3RyZWFtU3RvcHBlZCcpO1xuICAgIH1cbn07XG5cbkppbmdsZS5wcm90b3R5cGUuc2V0dXBBdWRpb01vbml0b3IgPSBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgbG9nKCdTZXR1cCBhdWRpbycpO1xuICAgIHZhciBhdWRpbyA9IGhhcmsoc3RyZWFtKTtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHRpbWVvdXQ7XG5cbiAgICBhdWRpby5vbignc3BlYWtpbmcnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmIChzZWxmLmhhcmRNdXRlZCkgcmV0dXJuO1xuICAgICAgICBzZWxmLnNldE1pY0lmRW5hYmxlZCgxKTtcbiAgICAgICAgc2VsZi5lbWl0KCdzcGVha2luZycpO1xuICAgIH0pO1xuXG4gICAgYXVkaW8ub24oJ3N0b3BwZWRfc3BlYWtpbmcnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmIChzZWxmLmhhcmRNdXRlZCkgcmV0dXJuO1xuICAgICAgICBpZiAodGltZW91dCkgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXG4gICAgICAgIHRpbWVvdXQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNlbGYuc2V0TWljSWZFbmFibGVkKDAuNSk7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ3N0b3BwZWRTcGVha2luZycpO1xuICAgICAgICB9LCAxMDAwKTtcbiAgICB9KTtcbn07XG5cbkppbmdsZS5wcm90b3R5cGUuc2V0TWljSWZFbmFibGVkID0gZnVuY3Rpb24gKHZvbHVtZSkge1xuICAgIGlmICghdGhpcy5jb25maWcuYXV0b0FkanVzdE1pYykgcmV0dXJuO1xuICAgIHRoaXMuZ2FpbkNvbnRyb2xsZXIuc2V0R2Fpbih2b2x1bWUpO1xufTtcblxuSmluZ2xlLnByb3RvdHlwZS5zZW5kRXJyb3IgPSBmdW5jdGlvbiAodG8sIGlkLCBkYXRhKSB7XG4gICAgZGF0YS50eXBlID0gJ2NhbmNlbCc7XG4gICAgdGhpcy5lbWl0KCdzZW5kJywge1xuICAgICAgICB0bzogdG8sXG4gICAgICAgIGlkOiBpZCxcbiAgICAgICAgdHlwZTogJ2Vycm9yJyxcbiAgICAgICAgZXJyb3I6IGRhdGFcbiAgICB9KTtcbn07XG5cbkppbmdsZS5wcm90b3R5cGUucHJvY2VzcyA9IGZ1bmN0aW9uIChyZXEpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICBpZiAocmVxLnR5cGUgPT09ICdlcnJvcicpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZW1pdCgnZXJyb3InLCByZXEpO1xuICAgIH1cblxuICAgIGlmIChyZXEudHlwZSA9PT0gJ3Jlc3VsdCcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHZhciBzaWRzLCBjdXJyc2lkLCBzZXNzO1xuICAgIHZhciBzaWQgPSByZXEuamluZ2xlLnNpZDtcbiAgICB2YXIgYWN0aW9uID0gcmVxLmppbmdsZS5hY3Rpb247XG4gICAgdmFyIGNvbnRlbnRzID0gcmVxLmppbmdsZS5jb250ZW50cyB8fCBbXTtcbiAgICB2YXIgY29udGVudFR5cGVzID0gXy5tYXAoY29udGVudHMsIGZ1bmN0aW9uIChjb250ZW50KSB7XG4gICAgICAgIHJldHVybiAoY29udGVudC5kZXNjcmlwdGlvbiB8fCB7fSkuZGVzY1R5cGU7XG4gICAgfSk7XG5cbiAgICB2YXIgc2Vzc2lvbiA9IHRoaXMuc2Vzc2lvbnNbc2lkXSB8fCBudWxsO1xuXG4gICAgdmFyIHNlbmRlciA9IHJlcS5mcm9tLmZ1bGwgfHwgcmVxLmZyb207XG4gICAgdmFyIHJlcWlkID0gcmVxLmlkO1xuXG4gICAgaWYgKGFjdGlvbiAhPT0gJ3Nlc3Npb24taW5pdGlhdGUnKSB7XG4gICAgICAgIC8vIENhbid0IG1vZGlmeSBhIHNlc3Npb24gdGhhdCB3ZSBkb24ndCBoYXZlLlxuICAgICAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgICAgICAgIGxvZygnVW5rbm93biBzZXNzaW9uJywgc2lkKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uOiAnaXRlbS1ub3QtZm91bmQnLFxuICAgICAgICAgICAgICAgIGppbmdsZUNvbmRpdGlvbjogJ3Vua25vd24tc2Vzc2lvbidcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ2hlY2sgaWYgc29tZW9uZSBpcyB0cnlpbmcgdG8gaGlqYWNrIGEgc2Vzc2lvbi5cbiAgICAgICAgaWYgKHNlc3Npb24ucGVlciAhPT0gc2VuZGVyIHx8IHNlc3Npb24uZW5kZWQpIHtcbiAgICAgICAgICAgIGxvZygnU2Vzc2lvbiBoYXMgZW5kZWQsIG9yIGFjdGlvbiBoYXMgd3Jvbmcgc2VuZGVyJyk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbjogJ2l0ZW0tbm90LWZvdW5kJyxcbiAgICAgICAgICAgICAgICBqaW5nbGVDb25kaXRpb246ICd1bmtub3duLXNlc3Npb24nXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENhbid0IGFjY2VwdCBhIHNlc3Npb24gdHdpY2VcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3Nlc3Npb24tYWNjZXB0JyAmJiAhc2Vzc2lvbi5wZW5kaW5nKSB7XG4gICAgICAgICAgICBsb2coJ1RyaWVkIHRvIGFjY2VwdCBzZXNzaW9uIHR3aWNlJywgc2lkKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uOiAndW5leHBlY3RlZC1yZXF1ZXN0JyxcbiAgICAgICAgICAgICAgICBqaW5nbGVDb25kaXRpb246ICdvdXQtb2Ytb3JkZXInXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENhbid0IHByb2Nlc3MgdHdvIHJlcXVlc3RzIGF0IG9uY2UsIG5lZWQgdG8gdGllIGJyZWFrXG4gICAgICAgIGlmIChhY3Rpb24gIT09ICdzZXNzaW9uLXRlcm1pbmF0ZScgJiYgc2Vzc2lvbi5wZW5kaW5nQWN0aW9uKSB7XG4gICAgICAgICAgICBsb2coJ1RpZSBicmVhayBkdXJpbmcgcGVuZGluZyByZXF1ZXN0Jyk7XG4gICAgICAgICAgICBpZiAoc2Vzc2lvbi5pc0luaXRpYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvbjogJ2NvbmZsaWN0JyxcbiAgICAgICAgICAgICAgICAgICAgamluZ2xlQ29uZGl0aW9uOiAndGllLWJyZWFrJ1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChzZXNzaW9uKSB7XG4gICAgICAgIC8vIERvbid0IGFjY2VwdCBhIG5ldyBzZXNzaW9uIGlmIHdlIGFscmVhZHkgaGF2ZSBvbmUuXG4gICAgICAgIGlmIChzZXNzaW9uLnBlZXIgIT09IHNlbmRlcikge1xuICAgICAgICAgICAgbG9nKCdEdXBsaWNhdGUgc2lkIGZyb20gbmV3IHNlbmRlcicpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuc2VuZEVycm9yKHNlbmRlciwgcmVxaWQsIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb246ICdzZXJ2aWNlLXVuYXZhaWxhYmxlJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDaGVjayBpZiB3ZSBuZWVkIHRvIGhhdmUgYSB0aWUgYnJlYWtlciBiZWNhdXNlIGJvdGggcGFydGllc1xuICAgICAgICAvLyBoYXBwZW5lZCB0byBwaWNrIHRoZSBzYW1lIHJhbmRvbSBzaWQuXG4gICAgICAgIGlmIChzZXNzaW9uLnBlbmRpbmcpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmppZCA+IHNlc3Npb24ucGVlcikge1xuICAgICAgICAgICAgICAgIGxvZygnVGllIGJyZWFrIG5ldyBzZXNzaW9uIGJlY2F1c2Ugb2YgZHVwbGljYXRlIHNpZHMnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb246ICdjb25mbGljdCcsXG4gICAgICAgICAgICAgICAgICAgIGppbmdsZUNvbmRpdGlvbjogJ3RpZS1icmVhaydcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFRoZSBvdGhlciBzaWRlIGlzIGp1c3QgZG9pbmcgaXQgd3JvbmcuXG4gICAgICAgIGxvZygnU29tZW9uZSBpcyBkb2luZyB0aGlzIHdyb25nJyk7XG4gICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICBjb25kaXRpb246ICd1bmV4cGVjdGVkLXJlcXVlc3QnLFxuICAgICAgICAgICAgamluZ2xlQ29uZGl0aW9uOiAnb3V0LW9mLW9yZGVyJ1xuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKE9iamVjdC5rZXlzKHRoaXMucGVlcnNbc2VuZGVyXSB8fCB7fSkubGVuZ3RoKSB7XG4gICAgICAgIC8vIENoZWNrIGlmIHdlIG5lZWQgdG8gaGF2ZSBhIHRpZSBicmVha2VyIGJlY2F1c2Ugd2UgYWxyZWFkeSBoYXZlIFxuICAgICAgICAvLyBhIGRpZmZlcmVudCBzZXNzaW9uIHRoYXQgaXMgdXNpbmcgdGhlIHJlcXVlc3RlZCBjb250ZW50IHR5cGVzLlxuICAgICAgICBzaWRzID0gT2JqZWN0LmtleXModGhpcy5wZWVyc1tzZW5kZXJdKTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzaWRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBjdXJyc2lkID0gc2lkc1tpXTtcbiAgICAgICAgICAgIHNlc3MgPSB0aGlzLnNlc3Npb25zW2N1cnJzaWRdO1xuICAgICAgICAgICAgaWYgKHNlc3MucGVuZGluZykge1xuICAgICAgICAgICAgICAgIGlmIChfLmludGVyc2VjdGlvbihjb250ZW50VHlwZXMsIHNlc3MuY29udGVudFR5cGVzKS5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gV2UgYWxyZWFkeSBoYXZlIGEgcGVuZGluZyBzZXNzaW9uIHJlcXVlc3QgZm9yIHRoaXMgY29udGVudCB0eXBlLlxuICAgICAgICAgICAgICAgICAgICBpZiAoY3VycnNpZCA+IHNpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gV2Ugd29uIHRoZSB0aWUgYnJlYWtlclxuICAgICAgICAgICAgICAgICAgICAgICAgbG9nKCdUaWUgYnJlYWsnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uOiAnY29uZmxpY3QnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGppbmdsZUNvbmRpdGlvbjogJ3RpZS1icmVhaydcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGFjdGlvbiA9PT0gJ3Nlc3Npb24taW5pdGlhdGUnKSB7XG4gICAgICAgIHZhciBvcHRzID0ge1xuICAgICAgICAgICAgc2lkOiBzaWQsXG4gICAgICAgICAgICBwZWVyOiBzZW5kZXIsXG4gICAgICAgICAgICBpbml0aWF0b3I6IGZhbHNlLFxuICAgICAgICAgICAgcGFyZW50OiB0aGlzXG4gICAgICAgIH07XG4gICAgICAgIGlmIChjb250ZW50VHlwZXMuaW5kZXhPZigncnRwJykgPj0gMCkge1xuICAgICAgICAgICAgc2Vzc2lvbiA9IG5ldyBNZWRpYVNlc3Npb24ob3B0cyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZXNzaW9uID0gbmV3IEdlbmVyaWNTZXNzaW9uKG9wdHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zZXNzaW9uc1tzaWRdID0gc2Vzc2lvbjtcbiAgICAgICAgaWYgKCF0aGlzLnBlZXJzW3NlbmRlcl0pIHtcbiAgICAgICAgICAgIHRoaXMucGVlcnNbc2VuZGVyXSA9IFtdO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucGVlcnNbc2VuZGVyXS5wdXNoKHNlc3Npb24pO1xuICAgIH1cblxuICAgIHNlc3Npb24ucHJvY2VzcyhhY3Rpb24sIHJlcS5qaW5nbGUsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgbG9nKCdDb3VsZCBub3QgcHJvY2VzcyByZXF1ZXN0JywgcmVxLCBlcnIpO1xuICAgICAgICAgICAgc2VsZi5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwgZXJyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNlbGYuZW1pdChcbiAgICAgICAgICAgICAgICAnc2VuZCcsXG4gICAgICAgICAgICAgICAgeyB0bzogc2VuZGVyLCBpZDogcmVxaWQsIHR5cGU6ICdyZXN1bHQnLCBhY3Rpb246IGFjdGlvbiB9XG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3Nlc3Npb24taW5pdGlhdGUnKSB7XG4gICAgICAgICAgICAgICAgbG9nKCdJbmNvbWluZyBzZXNzaW9uIHJlcXVlc3QgZnJvbSAnLCBzZW5kZXIsIHNlc3Npb24pO1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnaW5jb21pbmcnLCBzZXNzaW9uKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0pO1xufTtcblxuSmluZ2xlLnByb3RvdHlwZS5jcmVhdGVNZWRpYVNlc3Npb24gPSBmdW5jdGlvbiAocGVlciwgc2lkKSB7XG4gICAgdmFyIHNlc3Npb24gPSBuZXcgTWVkaWFTZXNzaW9uKHtcbiAgICAgICAgc2lkOiBzaWQsXG4gICAgICAgIHBlZXI6IHBlZXIsXG4gICAgICAgIGluaXRpYXRvcjogdHJ1ZSxcbiAgICAgICAgcGFyZW50OiB0aGlzXG4gICAgfSk7XG5cbiAgICBzaWQgPSBzZXNzaW9uLnNpZDtcblxuICAgIHRoaXMuc2Vzc2lvbnNbc2lkXSA9IHNlc3Npb247XG4gICAgaWYgKCF0aGlzLnBlZXJzW3BlZXJdKSB7XG4gICAgICAgIHRoaXMucGVlcnNbcGVlcl0gPSBbXTtcbiAgICB9XG4gICAgdGhpcy5wZWVyc1twZWVyXS5wdXNoKHNlc3Npb24pO1xuXG4gICAgbG9nKCdPdXRnb2luZyBzZXNzaW9uJywgc2Vzc2lvbi5zaWQsIHNlc3Npb24pO1xuICAgIHRoaXMuZW1pdCgnb3V0Z29pbmcnLCBzZXNzaW9uKTtcbiAgICByZXR1cm4gc2Vzc2lvbjtcbn07XG5cbkppbmdsZS5wcm90b3R5cGUuZW5kUGVlclNlc3Npb25zID0gZnVuY3Rpb24gKHBlZXIpIHtcbiAgICBsb2coJ0VuZGluZyBhbGwgc2Vzc2lvbnMgd2l0aCcsIHBlZXIpO1xuICAgIHZhciBzZXNzaW9ucyA9IHRoaXMucGVlcnNbcGVlcl0gfHwgW107XG4gICAgc2Vzc2lvbnMuZm9yRWFjaChmdW5jdGlvbiAoc2Vzc2lvbikge1xuICAgICAgICBzZXNzaW9uLmVuZCgpO1xuICAgIH0pO1xufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IEppbmdsZTtcbiIsInZhciBwcm9jZXNzPXJlcXVpcmUoXCJfX2Jyb3dzZXJpZnlfcHJvY2Vzc1wiKTsvKmdsb2JhbCBzZXRJbW1lZGlhdGU6IGZhbHNlLCBzZXRUaW1lb3V0OiBmYWxzZSwgY29uc29sZTogZmFsc2UgKi9cbihmdW5jdGlvbiAoKSB7XG5cbiAgICB2YXIgYXN5bmMgPSB7fTtcblxuICAgIC8vIGdsb2JhbCBvbiB0aGUgc2VydmVyLCB3aW5kb3cgaW4gdGhlIGJyb3dzZXJcbiAgICB2YXIgcm9vdCwgcHJldmlvdXNfYXN5bmM7XG5cbiAgICByb290ID0gdGhpcztcbiAgICBpZiAocm9vdCAhPSBudWxsKSB7XG4gICAgICBwcmV2aW91c19hc3luYyA9IHJvb3QuYXN5bmM7XG4gICAgfVxuXG4gICAgYXN5bmMubm9Db25mbGljdCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcm9vdC5hc3luYyA9IHByZXZpb3VzX2FzeW5jO1xuICAgICAgICByZXR1cm4gYXN5bmM7XG4gICAgfTtcblxuICAgIGZ1bmN0aW9uIG9ubHlfb25jZShmbikge1xuICAgICAgICB2YXIgY2FsbGVkID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChjYWxsZWQpIHRocm93IG5ldyBFcnJvcihcIkNhbGxiYWNrIHdhcyBhbHJlYWR5IGNhbGxlZC5cIik7XG4gICAgICAgICAgICBjYWxsZWQgPSB0cnVlO1xuICAgICAgICAgICAgZm4uYXBwbHkocm9vdCwgYXJndW1lbnRzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vLy8gY3Jvc3MtYnJvd3NlciBjb21wYXRpYmxpdHkgZnVuY3Rpb25zIC8vLy9cblxuICAgIHZhciBfZWFjaCA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yKSB7XG4gICAgICAgIGlmIChhcnIuZm9yRWFjaCkge1xuICAgICAgICAgICAgcmV0dXJuIGFyci5mb3JFYWNoKGl0ZXJhdG9yKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyci5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgICAgaXRlcmF0b3IoYXJyW2ldLCBpLCBhcnIpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHZhciBfbWFwID0gZnVuY3Rpb24gKGFyciwgaXRlcmF0b3IpIHtcbiAgICAgICAgaWYgKGFyci5tYXApIHtcbiAgICAgICAgICAgIHJldHVybiBhcnIubWFwKGl0ZXJhdG9yKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgICBfZWFjaChhcnIsIGZ1bmN0aW9uICh4LCBpLCBhKSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goaXRlcmF0b3IoeCwgaSwgYSkpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfTtcblxuICAgIHZhciBfcmVkdWNlID0gZnVuY3Rpb24gKGFyciwgaXRlcmF0b3IsIG1lbW8pIHtcbiAgICAgICAgaWYgKGFyci5yZWR1Y2UpIHtcbiAgICAgICAgICAgIHJldHVybiBhcnIucmVkdWNlKGl0ZXJhdG9yLCBtZW1vKTtcbiAgICAgICAgfVxuICAgICAgICBfZWFjaChhcnIsIGZ1bmN0aW9uICh4LCBpLCBhKSB7XG4gICAgICAgICAgICBtZW1vID0gaXRlcmF0b3IobWVtbywgeCwgaSwgYSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gbWVtbztcbiAgICB9O1xuXG4gICAgdmFyIF9rZXlzID0gZnVuY3Rpb24gKG9iaikge1xuICAgICAgICBpZiAoT2JqZWN0LmtleXMpIHtcbiAgICAgICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhvYmopO1xuICAgICAgICB9XG4gICAgICAgIHZhciBrZXlzID0gW107XG4gICAgICAgIGZvciAodmFyIGsgaW4gb2JqKSB7XG4gICAgICAgICAgICBpZiAob2JqLmhhc093blByb3BlcnR5KGspKSB7XG4gICAgICAgICAgICAgICAga2V5cy5wdXNoKGspO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBrZXlzO1xuICAgIH07XG5cbiAgICAvLy8vIGV4cG9ydGVkIGFzeW5jIG1vZHVsZSBmdW5jdGlvbnMgLy8vL1xuXG4gICAgLy8vLyBuZXh0VGljayBpbXBsZW1lbnRhdGlvbiB3aXRoIGJyb3dzZXItY29tcGF0aWJsZSBmYWxsYmFjayAvLy8vXG4gICAgaWYgKHR5cGVvZiBwcm9jZXNzID09PSAndW5kZWZpbmVkJyB8fCAhKHByb2Nlc3MubmV4dFRpY2spKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2V0SW1tZWRpYXRlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBhc3luYy5uZXh0VGljayA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgICAgIC8vIG5vdCBhIGRpcmVjdCBhbGlhcyBmb3IgSUUxMCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICAgICAgc2V0SW1tZWRpYXRlKGZuKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBhc3luYy5uZXh0VGljaztcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGFzeW5jLm5leHRUaWNrID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmbiwgMCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlID0gYXN5bmMubmV4dFRpY2s7XG4gICAgICAgIH1cbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICAgIGFzeW5jLm5leHRUaWNrID0gcHJvY2Vzcy5uZXh0VGljaztcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRJbW1lZGlhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBzZXRJbW1lZGlhdGU7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBhc3luYy5uZXh0VGljaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jLmVhY2ggPSBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKCFhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgY29tcGxldGVkID0gMDtcbiAgICAgICAgX2VhY2goYXJyLCBmdW5jdGlvbiAoeCkge1xuICAgICAgICAgICAgaXRlcmF0b3IoeCwgb25seV9vbmNlKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb21wbGV0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbXBsZXRlZCA+PSBhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5mb3JFYWNoID0gYXN5bmMuZWFjaDtcblxuICAgIGFzeW5jLmVhY2hTZXJpZXMgPSBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKCFhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgY29tcGxldGVkID0gMDtcbiAgICAgICAgdmFyIGl0ZXJhdGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpdGVyYXRvcihhcnJbY29tcGxldGVkXSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbXBsZXRlZCArPSAxO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY29tcGxldGVkID49IGFyci5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgaXRlcmF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG4gICAgICAgIGl0ZXJhdGUoKTtcbiAgICB9O1xuICAgIGFzeW5jLmZvckVhY2hTZXJpZXMgPSBhc3luYy5lYWNoU2VyaWVzO1xuXG4gICAgYXN5bmMuZWFjaExpbWl0ID0gZnVuY3Rpb24gKGFyciwgbGltaXQsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgZm4gPSBfZWFjaExpbWl0KGxpbWl0KTtcbiAgICAgICAgZm4uYXBwbHkobnVsbCwgW2FyciwgaXRlcmF0b3IsIGNhbGxiYWNrXSk7XG4gICAgfTtcbiAgICBhc3luYy5mb3JFYWNoTGltaXQgPSBhc3luYy5lYWNoTGltaXQ7XG5cbiAgICB2YXIgX2VhY2hMaW1pdCA9IGZ1bmN0aW9uIChsaW1pdCkge1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICBpZiAoIWFyci5sZW5ndGggfHwgbGltaXQgPD0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGNvbXBsZXRlZCA9IDA7XG4gICAgICAgICAgICB2YXIgc3RhcnRlZCA9IDA7XG4gICAgICAgICAgICB2YXIgcnVubmluZyA9IDA7XG5cbiAgICAgICAgICAgIChmdW5jdGlvbiByZXBsZW5pc2ggKCkge1xuICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgPj0gYXJyLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB3aGlsZSAocnVubmluZyA8IGxpbWl0ICYmIHN0YXJ0ZWQgPCBhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICAgICAgcnVubmluZyArPSAxO1xuICAgICAgICAgICAgICAgICAgICBpdGVyYXRvcihhcnJbc3RhcnRlZCAtIDFdLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGxldGVkICs9IDE7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcnVubmluZyAtPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgPj0gYXJyLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVwbGVuaXNoKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSgpO1xuICAgICAgICB9O1xuICAgIH07XG5cblxuICAgIHZhciBkb1BhcmFsbGVsID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW2FzeW5jLmVhY2hdLmNvbmNhdChhcmdzKSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICB2YXIgZG9QYXJhbGxlbExpbWl0ID0gZnVuY3Rpb24obGltaXQsIGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW19lYWNoTGltaXQobGltaXQpXS5jb25jYXQoYXJncykpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgdmFyIGRvU2VyaWVzID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW2FzeW5jLmVhY2hTZXJpZXNdLmNvbmNhdChhcmdzKSk7XG4gICAgICAgIH07XG4gICAgfTtcblxuXG4gICAgdmFyIF9hc3luY01hcCA9IGZ1bmN0aW9uIChlYWNoZm4sIGFyciwgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciByZXN1bHRzID0gW107XG4gICAgICAgIGFyciA9IF9tYXAoYXJyLCBmdW5jdGlvbiAoeCwgaSkge1xuICAgICAgICAgICAgcmV0dXJuIHtpbmRleDogaSwgdmFsdWU6IHh9O1xuICAgICAgICB9KTtcbiAgICAgICAgZWFjaGZuKGFyciwgZnVuY3Rpb24gKHgsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBpdGVyYXRvcih4LnZhbHVlLCBmdW5jdGlvbiAoZXJyLCB2KSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0c1t4LmluZGV4XSA9IHY7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIGFzeW5jLm1hcCA9IGRvUGFyYWxsZWwoX2FzeW5jTWFwKTtcbiAgICBhc3luYy5tYXBTZXJpZXMgPSBkb1NlcmllcyhfYXN5bmNNYXApO1xuICAgIGFzeW5jLm1hcExpbWl0ID0gZnVuY3Rpb24gKGFyciwgbGltaXQsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICByZXR1cm4gX21hcExpbWl0KGxpbWl0KShhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgfTtcblxuICAgIHZhciBfbWFwTGltaXQgPSBmdW5jdGlvbihsaW1pdCkge1xuICAgICAgICByZXR1cm4gZG9QYXJhbGxlbExpbWl0KGxpbWl0LCBfYXN5bmNNYXApO1xuICAgIH07XG5cbiAgICAvLyByZWR1Y2Ugb25seSBoYXMgYSBzZXJpZXMgdmVyc2lvbiwgYXMgZG9pbmcgcmVkdWNlIGluIHBhcmFsbGVsIHdvbid0XG4gICAgLy8gd29yayBpbiBtYW55IHNpdHVhdGlvbnMuXG4gICAgYXN5bmMucmVkdWNlID0gZnVuY3Rpb24gKGFyciwgbWVtbywgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMoYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKG1lbW8sIHgsIGZ1bmN0aW9uIChlcnIsIHYpIHtcbiAgICAgICAgICAgICAgICBtZW1vID0gdjtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVyciwgbWVtbyk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgLy8gaW5qZWN0IGFsaWFzXG4gICAgYXN5bmMuaW5qZWN0ID0gYXN5bmMucmVkdWNlO1xuICAgIC8vIGZvbGRsIGFsaWFzXG4gICAgYXN5bmMuZm9sZGwgPSBhc3luYy5yZWR1Y2U7XG5cbiAgICBhc3luYy5yZWR1Y2VSaWdodCA9IGZ1bmN0aW9uIChhcnIsIG1lbW8sIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgcmV2ZXJzZWQgPSBfbWFwKGFyciwgZnVuY3Rpb24gKHgpIHtcbiAgICAgICAgICAgIHJldHVybiB4O1xuICAgICAgICB9KS5yZXZlcnNlKCk7XG4gICAgICAgIGFzeW5jLnJlZHVjZShyZXZlcnNlZCwgbWVtbywgaXRlcmF0b3IsIGNhbGxiYWNrKTtcbiAgICB9O1xuICAgIC8vIGZvbGRyIGFsaWFzXG4gICAgYXN5bmMuZm9sZHIgPSBhc3luYy5yZWR1Y2VSaWdodDtcblxuICAgIHZhciBfZmlsdGVyID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIHJlc3VsdHMgPSBbXTtcbiAgICAgICAgYXJyID0gX21hcChhcnIsIGZ1bmN0aW9uICh4LCBpKSB7XG4gICAgICAgICAgICByZXR1cm4ge2luZGV4OiBpLCB2YWx1ZTogeH07XG4gICAgICAgIH0pO1xuICAgICAgICBlYWNoZm4oYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgudmFsdWUsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKHYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKF9tYXAocmVzdWx0cy5zb3J0KGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGEuaW5kZXggLSBiLmluZGV4O1xuICAgICAgICAgICAgfSksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHgudmFsdWU7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXN5bmMuZmlsdGVyID0gZG9QYXJhbGxlbChfZmlsdGVyKTtcbiAgICBhc3luYy5maWx0ZXJTZXJpZXMgPSBkb1NlcmllcyhfZmlsdGVyKTtcbiAgICAvLyBzZWxlY3QgYWxpYXNcbiAgICBhc3luYy5zZWxlY3QgPSBhc3luYy5maWx0ZXI7XG4gICAgYXN5bmMuc2VsZWN0U2VyaWVzID0gYXN5bmMuZmlsdGVyU2VyaWVzO1xuXG4gICAgdmFyIF9yZWplY3QgPSBmdW5jdGlvbiAoZWFjaGZuLCBhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgICBhcnIgPSBfbWFwKGFyciwgZnVuY3Rpb24gKHgsIGkpIHtcbiAgICAgICAgICAgIHJldHVybiB7aW5kZXg6IGksIHZhbHVlOiB4fTtcbiAgICAgICAgfSk7XG4gICAgICAgIGVhY2hmbihhcnIsIGZ1bmN0aW9uICh4LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgaXRlcmF0b3IoeC52YWx1ZSwgZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKF9tYXAocmVzdWx0cy5zb3J0KGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGEuaW5kZXggLSBiLmluZGV4O1xuICAgICAgICAgICAgfSksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHgudmFsdWU7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXN5bmMucmVqZWN0ID0gZG9QYXJhbGxlbChfcmVqZWN0KTtcbiAgICBhc3luYy5yZWplY3RTZXJpZXMgPSBkb1NlcmllcyhfcmVqZWN0KTtcblxuICAgIHZhciBfZGV0ZWN0ID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBpdGVyYXRvciwgbWFpbl9jYWxsYmFjaykge1xuICAgICAgICBlYWNoZm4oYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2soeCk7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIG1haW5fY2FsbGJhY2soKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5kZXRlY3QgPSBkb1BhcmFsbGVsKF9kZXRlY3QpO1xuICAgIGFzeW5jLmRldGVjdFNlcmllcyA9IGRvU2VyaWVzKF9kZXRlY3QpO1xuXG4gICAgYXN5bmMuc29tZSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBtYWluX2NhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2goYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKHYpIHtcbiAgICAgICAgICAgICAgICAgICAgbWFpbl9jYWxsYmFjayh0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgbWFpbl9jYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIG1haW5fY2FsbGJhY2soZmFsc2UpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIC8vIGFueSBhbGlhc1xuICAgIGFzeW5jLmFueSA9IGFzeW5jLnNvbWU7XG5cbiAgICBhc3luYy5ldmVyeSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBtYWluX2NhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2goYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKCF2KSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2soZmFsc2UpO1xuICAgICAgICAgICAgICAgICAgICBtYWluX2NhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgbWFpbl9jYWxsYmFjayh0cnVlKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICAvLyBhbGwgYWxpYXNcbiAgICBhc3luYy5hbGwgPSBhc3luYy5ldmVyeTtcblxuICAgIGFzeW5jLnNvcnRCeSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBhc3luYy5tYXAoYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uIChlcnIsIGNyaXRlcmlhKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwge3ZhbHVlOiB4LCBjcml0ZXJpYTogY3JpdGVyaWF9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVyciwgcmVzdWx0cykge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgdmFyIGZuID0gZnVuY3Rpb24gKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhID0gbGVmdC5jcml0ZXJpYSwgYiA9IHJpZ2h0LmNyaXRlcmlhO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSA8IGIgPyAtMSA6IGEgPiBiID8gMSA6IDA7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsLCBfbWFwKHJlc3VsdHMuc29ydChmbiksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB4LnZhbHVlO1xuICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLmF1dG8gPSBmdW5jdGlvbiAodGFza3MsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgIHZhciBrZXlzID0gX2tleXModGFza3MpO1xuICAgICAgICBpZiAoIWtleXMubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2sobnVsbCk7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuXG4gICAgICAgIHZhciBsaXN0ZW5lcnMgPSBbXTtcbiAgICAgICAgdmFyIGFkZExpc3RlbmVyID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICBsaXN0ZW5lcnMudW5zaGlmdChmbik7XG4gICAgICAgIH07XG4gICAgICAgIHZhciByZW1vdmVMaXN0ZW5lciA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaXN0ZW5lcnMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgICAgICBpZiAobGlzdGVuZXJzW2ldID09PSBmbikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB2YXIgdGFza0NvbXBsZXRlID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgX2VhY2gobGlzdGVuZXJzLnNsaWNlKDApLCBmdW5jdGlvbiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgYWRkTGlzdGVuZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKF9rZXlzKHJlc3VsdHMpLmxlbmd0aCA9PT0ga2V5cy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfZWFjaChrZXlzLCBmdW5jdGlvbiAoaykge1xuICAgICAgICAgICAgdmFyIHRhc2sgPSAodGFza3Nba10gaW5zdGFuY2VvZiBGdW5jdGlvbikgPyBbdGFza3Nba11dOiB0YXNrc1trXTtcbiAgICAgICAgICAgIHZhciB0YXNrQ2FsbGJhY2sgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgICAgIGlmIChhcmdzLmxlbmd0aCA8PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBzYWZlUmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICBfZWFjaChfa2V5cyhyZXN1bHRzKSwgZnVuY3Rpb24ocmtleSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2FmZVJlc3VsdHNbcmtleV0gPSByZXN1bHRzW3JrZXldO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgc2FmZVJlc3VsdHNba10gPSBhcmdzO1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIsIHNhZmVSZXN1bHRzKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gc3RvcCBzdWJzZXF1ZW50IGVycm9ycyBoaXR0aW5nIGNhbGxiYWNrIG11bHRpcGxlIHRpbWVzXG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRzW2tdID0gYXJncztcbiAgICAgICAgICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlKHRhc2tDb21wbGV0ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHZhciByZXF1aXJlcyA9IHRhc2suc2xpY2UoMCwgTWF0aC5hYnModGFzay5sZW5ndGggLSAxKSkgfHwgW107XG4gICAgICAgICAgICB2YXIgcmVhZHkgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF9yZWR1Y2UocmVxdWlyZXMsIGZ1bmN0aW9uIChhLCB4KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAoYSAmJiByZXN1bHRzLmhhc093blByb3BlcnR5KHgpKTtcbiAgICAgICAgICAgICAgICB9LCB0cnVlKSAmJiAhcmVzdWx0cy5oYXNPd25Qcm9wZXJ0eShrKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBpZiAocmVhZHkoKSkge1xuICAgICAgICAgICAgICAgIHRhc2tbdGFzay5sZW5ndGggLSAxXSh0YXNrQ2FsbGJhY2ssIHJlc3VsdHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVhZHkoKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFza1t0YXNrLmxlbmd0aCAtIDFdKHRhc2tDYWxsYmFjaywgcmVzdWx0cyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGFkZExpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLndhdGVyZmFsbCA9IGZ1bmN0aW9uICh0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKHRhc2tzLmNvbnN0cnVjdG9yICE9PSBBcnJheSkge1xuICAgICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ0ZpcnN0IGFyZ3VtZW50IHRvIHdhdGVyZmFsbCBtdXN0IGJlIGFuIGFycmF5IG9mIGZ1bmN0aW9ucycpO1xuICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghdGFza3MubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgd3JhcEl0ZXJhdG9yID0gZnVuY3Rpb24gKGl0ZXJhdG9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkobnVsbCwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIG5leHQgPSBpdGVyYXRvci5uZXh0KCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChuZXh0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmdzLnB1c2god3JhcEl0ZXJhdG9yKG5leHQpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MucHVzaChjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGl0ZXJhdG9yLmFwcGx5KG51bGwsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICB3cmFwSXRlcmF0b3IoYXN5bmMuaXRlcmF0b3IodGFza3MpKSgpO1xuICAgIH07XG5cbiAgICB2YXIgX3BhcmFsbGVsID0gZnVuY3Rpb24oZWFjaGZuLCB0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKHRhc2tzLmNvbnN0cnVjdG9yID09PSBBcnJheSkge1xuICAgICAgICAgICAgZWFjaGZuLm1hcCh0YXNrcywgZnVuY3Rpb24gKGZuLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChmbikge1xuICAgICAgICAgICAgICAgICAgICBmbihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suY2FsbChudWxsLCBlcnIsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgZWFjaGZuLmVhY2goX2tleXModGFza3MpLCBmdW5jdGlvbiAoaywgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB0YXNrc1trXShmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZ3MubGVuZ3RoIDw9IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdHNba10gPSBhcmdzO1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0cyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBhc3luYy5wYXJhbGxlbCA9IGZ1bmN0aW9uICh0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgX3BhcmFsbGVsKHsgbWFwOiBhc3luYy5tYXAsIGVhY2g6IGFzeW5jLmVhY2ggfSwgdGFza3MsIGNhbGxiYWNrKTtcbiAgICB9O1xuXG4gICAgYXN5bmMucGFyYWxsZWxMaW1pdCA9IGZ1bmN0aW9uKHRhc2tzLCBsaW1pdCwgY2FsbGJhY2spIHtcbiAgICAgICAgX3BhcmFsbGVsKHsgbWFwOiBfbWFwTGltaXQobGltaXQpLCBlYWNoOiBfZWFjaExpbWl0KGxpbWl0KSB9LCB0YXNrcywgY2FsbGJhY2spO1xuICAgIH07XG5cbiAgICBhc3luYy5zZXJpZXMgPSBmdW5jdGlvbiAodGFza3MsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgIGlmICh0YXNrcy5jb25zdHJ1Y3RvciA9PT0gQXJyYXkpIHtcbiAgICAgICAgICAgIGFzeW5jLm1hcFNlcmllcyh0YXNrcywgZnVuY3Rpb24gKGZuLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChmbikge1xuICAgICAgICAgICAgICAgICAgICBmbihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suY2FsbChudWxsLCBlcnIsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhfa2V5cyh0YXNrcyksIGZ1bmN0aW9uIChrLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHRhc2tzW2tdKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJncyA9IGFyZ3NbMF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0c1trXSA9IGFyZ3M7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCByZXN1bHRzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGFzeW5jLml0ZXJhdG9yID0gZnVuY3Rpb24gKHRhc2tzKSB7XG4gICAgICAgIHZhciBtYWtlQ2FsbGJhY2sgPSBmdW5jdGlvbiAoaW5kZXgpIHtcbiAgICAgICAgICAgIHZhciBmbiA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAodGFza3MubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHRhc2tzW2luZGV4XS5hcHBseShudWxsLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZm4ubmV4dCgpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGZuLm5leHQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIChpbmRleCA8IHRhc2tzLmxlbmd0aCAtIDEpID8gbWFrZUNhbGxiYWNrKGluZGV4ICsgMSk6IG51bGw7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcmV0dXJuIGZuO1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gbWFrZUNhbGxiYWNrKDApO1xuICAgIH07XG5cbiAgICBhc3luYy5hcHBseSA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkoXG4gICAgICAgICAgICAgICAgbnVsbCwgYXJncy5jb25jYXQoQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKSlcbiAgICAgICAgICAgICk7XG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIHZhciBfY29uY2F0ID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBmbiwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIHIgPSBbXTtcbiAgICAgICAgZWFjaGZuKGFyciwgZnVuY3Rpb24gKHgsIGNiKSB7XG4gICAgICAgICAgICBmbih4LCBmdW5jdGlvbiAoZXJyLCB5KSB7XG4gICAgICAgICAgICAgICAgciA9IHIuY29uY2F0KHkgfHwgW10pO1xuICAgICAgICAgICAgICAgIGNiKGVycik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyLCByKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5jb25jYXQgPSBkb1BhcmFsbGVsKF9jb25jYXQpO1xuICAgIGFzeW5jLmNvbmNhdFNlcmllcyA9IGRvU2VyaWVzKF9jb25jYXQpO1xuXG4gICAgYXN5bmMud2hpbHN0ID0gZnVuY3Rpb24gKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBpZiAodGVzdCgpKSB7XG4gICAgICAgICAgICBpdGVyYXRvcihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYXN5bmMud2hpbHN0KHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgYXN5bmMuZG9XaGlsc3QgPSBmdW5jdGlvbiAoaXRlcmF0b3IsIHRlc3QsIGNhbGxiYWNrKSB7XG4gICAgICAgIGl0ZXJhdG9yKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0ZXN0KCkpIHtcbiAgICAgICAgICAgICAgICBhc3luYy5kb1doaWxzdChpdGVyYXRvciwgdGVzdCwgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLnVudGlsID0gZnVuY3Rpb24gKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBpZiAoIXRlc3QoKSkge1xuICAgICAgICAgICAgaXRlcmF0b3IoZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGFzeW5jLnVudGlsKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgYXN5bmMuZG9VbnRpbCA9IGZ1bmN0aW9uIChpdGVyYXRvciwgdGVzdCwgY2FsbGJhY2spIHtcbiAgICAgICAgaXRlcmF0b3IoZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCF0ZXN0KCkpIHtcbiAgICAgICAgICAgICAgICBhc3luYy5kb1VudGlsKGl0ZXJhdG9yLCB0ZXN0LCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9O1xuXG4gICAgYXN5bmMucXVldWUgPSBmdW5jdGlvbiAod29ya2VyLCBjb25jdXJyZW5jeSkge1xuICAgICAgICBpZiAoY29uY3VycmVuY3kgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgY29uY3VycmVuY3kgPSAxO1xuICAgICAgICB9XG4gICAgICAgIGZ1bmN0aW9uIF9pbnNlcnQocSwgZGF0YSwgcG9zLCBjYWxsYmFjaykge1xuICAgICAgICAgIGlmKGRhdGEuY29uc3RydWN0b3IgIT09IEFycmF5KSB7XG4gICAgICAgICAgICAgIGRhdGEgPSBbZGF0YV07XG4gICAgICAgICAgfVxuICAgICAgICAgIF9lYWNoKGRhdGEsIGZ1bmN0aW9uKHRhc2spIHtcbiAgICAgICAgICAgICAgdmFyIGl0ZW0gPSB7XG4gICAgICAgICAgICAgICAgICBkYXRhOiB0YXNrLFxuICAgICAgICAgICAgICAgICAgY2FsbGJhY2s6IHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJyA/IGNhbGxiYWNrIDogbnVsbFxuICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgIGlmIChwb3MpIHtcbiAgICAgICAgICAgICAgICBxLnRhc2tzLnVuc2hpZnQoaXRlbSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcS50YXNrcy5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgaWYgKHEuc2F0dXJhdGVkICYmIHEudGFza3MubGVuZ3RoID09PSBjb25jdXJyZW5jeSkge1xuICAgICAgICAgICAgICAgICAgcS5zYXR1cmF0ZWQoKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUocS5wcm9jZXNzKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciB3b3JrZXJzID0gMDtcbiAgICAgICAgdmFyIHEgPSB7XG4gICAgICAgICAgICB0YXNrczogW10sXG4gICAgICAgICAgICBjb25jdXJyZW5jeTogY29uY3VycmVuY3ksXG4gICAgICAgICAgICBzYXR1cmF0ZWQ6IG51bGwsXG4gICAgICAgICAgICBlbXB0eTogbnVsbCxcbiAgICAgICAgICAgIGRyYWluOiBudWxsLFxuICAgICAgICAgICAgcHVzaDogZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgIF9pbnNlcnQocSwgZGF0YSwgZmFsc2UsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB1bnNoaWZ0OiBmdW5jdGlvbiAoZGF0YSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgX2luc2VydChxLCBkYXRhLCB0cnVlLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcHJvY2VzczogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmICh3b3JrZXJzIDwgcS5jb25jdXJyZW5jeSAmJiBxLnRhc2tzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgdGFzayA9IHEudGFza3Muc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHEuZW1wdHkgJiYgcS50YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHEuZW1wdHkoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB3b3JrZXJzICs9IDE7XG4gICAgICAgICAgICAgICAgICAgIHZhciBuZXh0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgd29ya2VycyAtPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhc2suY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXNrLmNhbGxiYWNrLmFwcGx5KHRhc2ssIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocS5kcmFpbiAmJiBxLnRhc2tzLmxlbmd0aCArIHdvcmtlcnMgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxLmRyYWluKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBxLnByb2Nlc3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNiID0gb25seV9vbmNlKG5leHQpO1xuICAgICAgICAgICAgICAgICAgICB3b3JrZXIodGFzay5kYXRhLCBjYik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGxlbmd0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBxLnRhc2tzLmxlbmd0aDtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBydW5uaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdvcmtlcnM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBxO1xuICAgIH07XG5cbiAgICBhc3luYy5jYXJnbyA9IGZ1bmN0aW9uICh3b3JrZXIsIHBheWxvYWQpIHtcbiAgICAgICAgdmFyIHdvcmtpbmcgICAgID0gZmFsc2UsXG4gICAgICAgICAgICB0YXNrcyAgICAgICA9IFtdO1xuXG4gICAgICAgIHZhciBjYXJnbyA9IHtcbiAgICAgICAgICAgIHRhc2tzOiB0YXNrcyxcbiAgICAgICAgICAgIHBheWxvYWQ6IHBheWxvYWQsXG4gICAgICAgICAgICBzYXR1cmF0ZWQ6IG51bGwsXG4gICAgICAgICAgICBlbXB0eTogbnVsbCxcbiAgICAgICAgICAgIGRyYWluOiBudWxsLFxuICAgICAgICAgICAgcHVzaDogZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYoZGF0YS5jb25zdHJ1Y3RvciAhPT0gQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YSA9IFtkYXRhXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgX2VhY2goZGF0YSwgZnVuY3Rpb24odGFzaykge1xuICAgICAgICAgICAgICAgICAgICB0YXNrcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IHRhc2ssXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjazogdHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nID8gY2FsbGJhY2sgOiBudWxsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY2FyZ28uc2F0dXJhdGVkICYmIHRhc2tzLmxlbmd0aCA9PT0gcGF5bG9hZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FyZ28uc2F0dXJhdGVkKCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUoY2FyZ28ucHJvY2Vzcyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcHJvY2VzczogZnVuY3Rpb24gcHJvY2VzcygpIHtcbiAgICAgICAgICAgICAgICBpZiAod29ya2luZykgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYoY2FyZ28uZHJhaW4pIGNhcmdvLmRyYWluKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdHMgPSB0eXBlb2YgcGF5bG9hZCA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHRhc2tzLnNwbGljZSgwLCBwYXlsb2FkKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdGFza3Muc3BsaWNlKDApO1xuXG4gICAgICAgICAgICAgICAgdmFyIGRzID0gX21hcCh0cywgZnVuY3Rpb24gKHRhc2spIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRhc2suZGF0YTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGlmKGNhcmdvLmVtcHR5KSBjYXJnby5lbXB0eSgpO1xuICAgICAgICAgICAgICAgIHdvcmtpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHdvcmtlcihkcywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICB3b3JraW5nID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgIF9lYWNoKHRzLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRhdGEuY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLmNhbGxiYWNrLmFwcGx5KG51bGwsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBwcm9jZXNzKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgbGVuZ3RoOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRhc2tzLmxlbmd0aDtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBydW5uaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdvcmtpbmc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBjYXJnbztcbiAgICB9O1xuXG4gICAgdmFyIF9jb25zb2xlX2ZuID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgZm4uYXBwbHkobnVsbCwgYXJncy5jb25jYXQoW2Z1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29uc29sZS5lcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBlbHNlIGlmIChjb25zb2xlW25hbWVdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBfZWFjaChhcmdzLCBmdW5jdGlvbiAoeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGVbbmFtZV0oeCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1dKSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICBhc3luYy5sb2cgPSBfY29uc29sZV9mbignbG9nJyk7XG4gICAgYXN5bmMuZGlyID0gX2NvbnNvbGVfZm4oJ2RpcicpO1xuICAgIC8qYXN5bmMuaW5mbyA9IF9jb25zb2xlX2ZuKCdpbmZvJyk7XG4gICAgYXN5bmMud2FybiA9IF9jb25zb2xlX2ZuKCd3YXJuJyk7XG4gICAgYXN5bmMuZXJyb3IgPSBfY29uc29sZV9mbignZXJyb3InKTsqL1xuXG4gICAgYXN5bmMubWVtb2l6ZSA9IGZ1bmN0aW9uIChmbiwgaGFzaGVyKSB7XG4gICAgICAgIHZhciBtZW1vID0ge307XG4gICAgICAgIHZhciBxdWV1ZXMgPSB7fTtcbiAgICAgICAgaGFzaGVyID0gaGFzaGVyIHx8IGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICByZXR1cm4geDtcbiAgICAgICAgfTtcbiAgICAgICAgdmFyIG1lbW9pemVkID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgICAgICAgICAgdmFyIGNhbGxiYWNrID0gYXJncy5wb3AoKTtcbiAgICAgICAgICAgIHZhciBrZXkgPSBoYXNoZXIuYXBwbHkobnVsbCwgYXJncyk7XG4gICAgICAgICAgICBpZiAoa2V5IGluIG1lbW8pIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShudWxsLCBtZW1vW2tleV0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSBpZiAoa2V5IGluIHF1ZXVlcykge1xuICAgICAgICAgICAgICAgIHF1ZXVlc1trZXldLnB1c2goY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVldWVzW2tleV0gPSBbY2FsbGJhY2tdO1xuICAgICAgICAgICAgICAgIGZuLmFwcGx5KG51bGwsIGFyZ3MuY29uY2F0KFtmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lbW9ba2V5XSA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgdmFyIHEgPSBxdWV1ZXNba2V5XTtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHF1ZXVlc1trZXldO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMCwgbCA9IHEubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgcVtpXS5hcHBseShudWxsLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfV0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgbWVtb2l6ZWQubWVtbyA9IG1lbW87XG4gICAgICAgIG1lbW9pemVkLnVubWVtb2l6ZWQgPSBmbjtcbiAgICAgICAgcmV0dXJuIG1lbW9pemVkO1xuICAgIH07XG5cbiAgICBhc3luYy51bm1lbW9pemUgPSBmdW5jdGlvbiAoZm4pIHtcbiAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiAoZm4udW5tZW1vaXplZCB8fCBmbikuYXBwbHkobnVsbCwgYXJndW1lbnRzKTtcbiAgICAgIH07XG4gICAgfTtcblxuICAgIGFzeW5jLnRpbWVzID0gZnVuY3Rpb24gKGNvdW50LCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIGNvdW50ZXIgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb3VudDsgaSsrKSB7XG4gICAgICAgICAgICBjb3VudGVyLnB1c2goaSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGFzeW5jLm1hcChjb3VudGVyLCBpdGVyYXRvciwgY2FsbGJhY2spO1xuICAgIH07XG5cbiAgICBhc3luYy50aW1lc1NlcmllcyA9IGZ1bmN0aW9uIChjb3VudCwgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciBjb3VudGVyID0gW107XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY291bnQ7IGkrKykge1xuICAgICAgICAgICAgY291bnRlci5wdXNoKGkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBhc3luYy5tYXBTZXJpZXMoY291bnRlciwgaXRlcmF0b3IsIGNhbGxiYWNrKTtcbiAgICB9O1xuXG4gICAgYXN5bmMuY29tcG9zZSA9IGZ1bmN0aW9uICgvKiBmdW5jdGlvbnMuLi4gKi8pIHtcbiAgICAgICAgdmFyIGZucyA9IEFycmF5LnByb3RvdHlwZS5yZXZlcnNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB0aGF0ID0gdGhpcztcbiAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHZhciBjYWxsYmFjayA9IGFyZ3MucG9wKCk7XG4gICAgICAgICAgICBhc3luYy5yZWR1Y2UoZm5zLCBhcmdzLCBmdW5jdGlvbiAobmV3YXJncywgZm4sIGNiKSB7XG4gICAgICAgICAgICAgICAgZm4uYXBwbHkodGhhdCwgbmV3YXJncy5jb25jYXQoW2Z1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGVyciA9IGFyZ3VtZW50c1swXTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIG5leHRhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgY2IoZXJyLCBuZXh0YXJncyk7XG4gICAgICAgICAgICAgICAgfV0pKVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGZ1bmN0aW9uIChlcnIsIHJlc3VsdHMpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseSh0aGF0LCBbZXJyXS5jb25jYXQocmVzdWx0cykpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIHZhciBfYXBwbHlFYWNoID0gZnVuY3Rpb24gKGVhY2hmbiwgZm5zIC8qYXJncy4uLiovKSB7XG4gICAgICAgIHZhciBnbyA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB0aGF0ID0gdGhpcztcbiAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHZhciBjYWxsYmFjayA9IGFyZ3MucG9wKCk7XG4gICAgICAgICAgICByZXR1cm4gZWFjaGZuKGZucywgZnVuY3Rpb24gKGZuLCBjYikge1xuICAgICAgICAgICAgICAgIGZuLmFwcGx5KHRoYXQsIGFyZ3MuY29uY2F0KFtjYl0pKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjYWxsYmFjayk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgICAgICAgICAgcmV0dXJuIGdvLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIGdvO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBhc3luYy5hcHBseUVhY2ggPSBkb1BhcmFsbGVsKF9hcHBseUVhY2gpO1xuICAgIGFzeW5jLmFwcGx5RWFjaFNlcmllcyA9IGRvU2VyaWVzKF9hcHBseUVhY2gpO1xuXG4gICAgYXN5bmMuZm9yZXZlciA9IGZ1bmN0aW9uIChmbiwgY2FsbGJhY2spIHtcbiAgICAgICAgZnVuY3Rpb24gbmV4dChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZuKG5leHQpO1xuICAgICAgICB9XG4gICAgICAgIG5leHQoKTtcbiAgICB9O1xuXG4gICAgLy8gQU1EIC8gUmVxdWlyZUpTXG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgIT09ICd1bmRlZmluZWQnICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKFtdLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gYXN5bmM7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICAvLyBOb2RlLmpzXG4gICAgZWxzZSBpZiAodHlwZW9mIG1vZHVsZSAhPT0gJ3VuZGVmaW5lZCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBhc3luYztcbiAgICB9XG4gICAgLy8gaW5jbHVkZWQgZGlyZWN0bHkgdmlhIDxzY3JpcHQ+IHRhZ1xuICAgIGVsc2Uge1xuICAgICAgICByb290LmFzeW5jID0gYXN5bmM7XG4gICAgfVxuXG59KCkpO1xuIiwiKGZ1bmN0aW9uKCkge1xuICB2YXIgaW5Ob2RlID0gdHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcsXG4gICAgICBscyA9ICFpbk5vZGUgJiYgd2luZG93LmxvY2FsU3RvcmFnZSxcbiAgICAgIGRlYnVnID0gbHMuZGVidWcsXG4gICAgICBsb2dnZXIgPSByZXF1aXJlKCdhbmRsb2cnKSxcbiAgICAgIGdvbGRlblJhdGlvID0gMC42MTgwMzM5ODg3NDk4OTUsXG4gICAgICBodWUgPSAwLFxuICAgICAgcGFkTGVuZ3RoID0gMTUsXG4gICAgICBub29wID0gZnVuY3Rpb24oKSB7fSxcbiAgICAgIHlpZWxkQ29sb3IsXG4gICAgICBib3dzLFxuICAgICAgZGVidWdSZWdleDtcblxuICB5aWVsZENvbG9yID0gZnVuY3Rpb24oKSB7XG4gICAgaHVlICs9IGdvbGRlblJhdGlvO1xuICAgIGh1ZSA9IGh1ZSAlIDE7XG4gICAgcmV0dXJuIGh1ZSAqIDM2MDtcbiAgfTtcblxuICB2YXIgZGVidWdSZWdleCA9IGRlYnVnICYmIGRlYnVnWzBdPT09Jy8nICYmIG5ldyBSZWdFeHAoZGVidWcuc3Vic3RyaW5nKDEsZGVidWcubGVuZ3RoLTEpKTtcblxuICBib3dzID0gZnVuY3Rpb24oc3RyKSB7XG4gICAgdmFyIG1zZztcbiAgICBtc2cgPSBcIiVjXCIgKyAoc3RyLnNsaWNlKDAsIHBhZExlbmd0aCkpO1xuICAgIG1zZyArPSBBcnJheShwYWRMZW5ndGggKyAzIC0gbXNnLmxlbmd0aCkuam9pbignICcpICsgJ3wnO1xuXG4gICAgaWYgKGRlYnVnUmVnZXggJiYgIXN0ci5tYXRjaChkZWJ1Z1JlZ2V4KSkgcmV0dXJuIG5vb3A7XG4gICAgaWYgKCF3aW5kb3cuY2hyb21lKSByZXR1cm4gbG9nZ2VyLmxvZy5iaW5kKGxvZ2dlciwgbXNnKTtcbiAgICByZXR1cm4gbG9nZ2VyLmxvZy5iaW5kKGxvZ2dlciwgbXNnLCBcImNvbG9yOiBoc2woXCIgKyAoeWllbGRDb2xvcigpKSArIFwiLDk5JSw0MCUpOyBmb250LXdlaWdodDogYm9sZFwiKTtcbiAgfTtcblxuICBib3dzLmNvbmZpZyA9IGZ1bmN0aW9uKGNvbmZpZykge1xuICAgIGlmIChjb25maWcucGFkTGVuZ3RoKSB7XG4gICAgICByZXR1cm4gcGFkTGVuZ3RoID0gY29uZmlnLnBhZExlbmd0aDtcbiAgICB9XG4gIH07XG5cbiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9kdWxlLmV4cG9ydHMgPSBib3dzO1xuICB9IGVsc2Uge1xuICAgIHdpbmRvdy5ib3dzID0gYm93cztcbiAgfVxufSkuY2FsbCgpO1xuIiwiLy8gZm9sbG93IEBIZW5yaWtKb3JldGVnIGFuZCBAYW5keWV0IGlmIHlvdSBsaWtlIHRoaXMgOylcbihmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGluTm9kZSA9IHR5cGVvZiB3aW5kb3cgPT09ICd1bmRlZmluZWQnLFxuICAgICAgICBscyA9ICFpbk5vZGUgJiYgd2luZG93LmxvY2FsU3RvcmFnZSxcbiAgICAgICAgb3V0ID0ge307XG5cbiAgICBpZiAoaW5Ob2RlKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gY29uc29sZTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChscyAmJiBscy5kZWJ1ZyAmJiB3aW5kb3cuY29uc29sZSkge1xuICAgICAgICBvdXQgPSB3aW5kb3cuY29uc29sZTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbWV0aG9kcyA9IFwiYXNzZXJ0LGNvdW50LGRlYnVnLGRpcixkaXJ4bWwsZXJyb3IsZXhjZXB0aW9uLGdyb3VwLGdyb3VwQ29sbGFwc2VkLGdyb3VwRW5kLGluZm8sbG9nLG1hcmtUaW1lbGluZSxwcm9maWxlLHByb2ZpbGVFbmQsdGltZSx0aW1lRW5kLHRyYWNlLHdhcm5cIi5zcGxpdChcIixcIiksXG4gICAgICAgICAgICBsID0gbWV0aG9kcy5sZW5ndGgsXG4gICAgICAgICAgICBmbiA9IGZ1bmN0aW9uICgpIHt9O1xuXG4gICAgICAgIHdoaWxlIChsLS0pIHtcbiAgICAgICAgICAgIG91dFttZXRob2RzW2xdXSA9IGZuO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZXhwb3J0cyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBvdXQ7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgd2luZG93LmNvbnNvbGUgPSBvdXQ7XG4gICAgfVxufSkoKTtcbiIsIi8vIGdldFVzZXJNZWRpYSBoZWxwZXIgYnkgQEhlbnJpa0pvcmV0ZWdcbnZhciBmdW5jID0gKG5hdmlnYXRvci5nZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci53ZWJraXRHZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci5tb3pHZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci5tc0dldFVzZXJNZWRpYSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoY29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIG9wdGlvbnM7XG4gICAgdmFyIGhhdmVPcHRzID0gYXJndW1lbnRzLmxlbmd0aCA9PT0gMjtcbiAgICB2YXIgZGVmYXVsdE9wdHMgPSB7dmlkZW86IHRydWUsIGF1ZGlvOiB0cnVlfTtcbiAgICB2YXIgZXJyb3I7XG4gICAgdmFyIGRlbmllZCA9ICdQRVJNSVNTSU9OX0RFTklFRCc7XG4gICAgdmFyIG5vdFNhdGlmaWVkID0gJ0NPTlNUUkFJTlRfTk9UX1NBVElTRklFRCc7XG5cbiAgICAvLyBtYWtlIGNvbnN0cmFpbnRzIG9wdGlvbmFsXG4gICAgaWYgKCFoYXZlT3B0cykge1xuICAgICAgICBjYiA9IGNvbnN0cmFpbnRzO1xuICAgICAgICBjb25zdHJhaW50cyA9IGRlZmF1bHRPcHRzO1xuICAgIH1cblxuICAgIC8vIHRyZWF0IGxhY2sgb2YgYnJvd3NlciBzdXBwb3J0IGxpa2UgYW4gZXJyb3JcbiAgICBpZiAoIWZ1bmMpIHtcbiAgICAgICAgLy8gdGhyb3cgcHJvcGVyIGVycm9yIHBlciBzcGVjXG4gICAgICAgIGVycm9yID0gbmV3IEVycm9yKCdOYXZpZ2F0b3JVc2VyTWVkaWFFcnJvcicpO1xuICAgICAgICBlcnJvci5uYW1lID0gJ05PVF9TVVBQT1JURURfRVJST1InO1xuICAgICAgICByZXR1cm4gY2IoZXJyb3IpO1xuICAgIH1cblxuICAgIGZ1bmMuY2FsbChuYXZpZ2F0b3IsIGNvbnN0cmFpbnRzLCBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgICAgIGNiKG51bGwsIHN0cmVhbSk7XG4gICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICB2YXIgZXJyb3I7XG4gICAgICAgIC8vIGNvZXJjZSBpbnRvIGFuIGVycm9yIG9iamVjdCBzaW5jZSBGRiBnaXZlcyB1cyBhIHN0cmluZ1xuICAgICAgICAvLyB0aGVyZSBhcmUgb25seSB0d28gdmFsaWQgbmFtZXMgYWNjb3JkaW5nIHRvIHRoZSBzcGVjXG4gICAgICAgIC8vIHdlIGNvZXJjZSBhbGwgbm9uLWRlbmllZCB0byBcImNvbnN0cmFpbnQgbm90IHNhdGlzZmllZFwiLlxuICAgICAgICBpZiAodHlwZW9mIGVyciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGVycm9yID0gbmV3IEVycm9yKCdOYXZpZ2F0b3JVc2VyTWVkaWFFcnJvcicpO1xuICAgICAgICAgICAgaWYgKGVyciA9PT0gZGVuaWVkKSB7XG4gICAgICAgICAgICAgICAgZXJyb3IubmFtZSA9IGRlbmllZDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXJyb3IubmFtZSA9IG5vdFNhdGlmaWVkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gaWYgd2UgZ2V0IGFuIGVycm9yIG9iamVjdCBtYWtlIHN1cmUgJy5uYW1lJyBwcm9wZXJ0eSBpcyBzZXRcbiAgICAgICAgICAgIC8vIGFjY29yZGluZyB0byBzcGVjOiBodHRwOi8vZGV2LnczLm9yZy8yMDExL3dlYnJ0Yy9lZGl0b3IvZ2V0dXNlcm1lZGlhLmh0bWwjbmF2aWdhdG9ydXNlcm1lZGlhZXJyb3ItYW5kLW5hdmlnYXRvcnVzZXJtZWRpYWVycm9yY2FsbGJhY2tcbiAgICAgICAgICAgIGVycm9yID0gZXJyO1xuICAgICAgICAgICAgaWYgKCFlcnJvci5uYW1lKSB7XG4gICAgICAgICAgICAgICAgLy8gdGhpcyBpcyBsaWtlbHkgY2hyb21lIHdoaWNoXG4gICAgICAgICAgICAgICAgLy8gc2V0cyBhIHByb3BlcnR5IGNhbGxlZCBcIkVSUk9SX0RFTklFRFwiIG9uIHRoZSBlcnJvciBvYmplY3RcbiAgICAgICAgICAgICAgICAvLyBpZiBzbyB3ZSBtYWtlIHN1cmUgdG8gc2V0IGEgbmFtZVxuICAgICAgICAgICAgICAgIGlmIChlcnJvcltkZW5pZWRdKSB7XG4gICAgICAgICAgICAgICAgICAgIGVyci5uYW1lID0gZGVuaWVkO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGVyci5uYW1lID0gbm90U2F0aWZpZWQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY2IoZXJyb3IpO1xuICAgIH0pO1xufTtcbiIsInZhciBXaWxkRW1pdHRlciA9IHJlcXVpcmUoJ3dpbGRlbWl0dGVyJyk7XG5cbmZ1bmN0aW9uIGdldE1heFZvbHVtZSAoYW5hbHlzZXIsIGZmdEJpbnMpIHtcbiAgdmFyIG1heFZvbHVtZSA9IC1JbmZpbml0eTtcbiAgYW5hbHlzZXIuZ2V0RmxvYXRGcmVxdWVuY3lEYXRhKGZmdEJpbnMpO1xuXG4gIGZvcih2YXIgaT0wLCBpaT1mZnRCaW5zLmxlbmd0aDsgaSA8IGlpOyBpKyspIHtcbiAgICBpZiAoZmZ0Qmluc1tpXSA+IG1heFZvbHVtZSAmJiBmZnRCaW5zW2ldIDwgMCkge1xuICAgICAgbWF4Vm9sdW1lID0gZmZ0Qmluc1tpXTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIG1heFZvbHVtZTtcbn1cblxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHN0cmVhbSwgb3B0aW9ucykge1xuICB2YXIgaGFya2VyID0gbmV3IFdpbGRFbWl0dGVyKCk7XG5cbiAgLy8gbWFrZSBpdCBub3QgYnJlYWsgaW4gbm9uLXN1cHBvcnRlZCBicm93c2Vyc1xuICBpZiAoIXdpbmRvdy53ZWJraXRBdWRpb0NvbnRleHQpIHJldHVybiBoYXJrZXI7XG5cbiAgLy9Db25maWdcbiAgdmFyIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9LFxuICAgICAgc21vb3RoaW5nID0gKG9wdGlvbnMuc21vb3RoaW5nIHx8IDAuNSksXG4gICAgICBpbnRlcnZhbCA9IChvcHRpb25zLmludGVydmFsIHx8IDEwMCksXG4gICAgICB0aHJlc2hvbGQgPSBvcHRpb25zLnRocmVzaG9sZCxcbiAgICAgIHBsYXkgPSBvcHRpb25zLnBsYXk7XG5cbiAgLy9TZXR1cCBBdWRpbyBDb250ZXh0XG4gIHZhciBhdWRpb0NvbnRleHQgPSBuZXcgd2Via2l0QXVkaW9Db250ZXh0KCk7XG4gIHZhciBzb3VyY2VOb2RlLCBmZnRCaW5zLCBhbmFseXNlcjtcblxuICBhbmFseXNlciA9IGF1ZGlvQ29udGV4dC5jcmVhdGVBbmFseXNlcigpO1xuICBhbmFseXNlci5mZnRTaXplID0gNTEyO1xuICBhbmFseXNlci5zbW9vdGhpbmdUaW1lQ29uc3RhbnQgPSBzbW9vdGhpbmc7XG4gIGZmdEJpbnMgPSBuZXcgRmxvYXQzMkFycmF5KGFuYWx5c2VyLmZmdFNpemUpO1xuXG4gIGlmIChzdHJlYW0uanF1ZXJ5KSBzdHJlYW0gPSBzdHJlYW1bMF07XG4gIGlmIChzdHJlYW0gaW5zdGFuY2VvZiBIVE1MQXVkaW9FbGVtZW50KSB7XG4gICAgLy9BdWRpbyBUYWdcbiAgICBzb3VyY2VOb2RlID0gYXVkaW9Db250ZXh0LmNyZWF0ZU1lZGlhRWxlbWVudFNvdXJjZShzdHJlYW0pO1xuICAgIGlmICh0eXBlb2YgcGxheSA9PT0gJ3VuZGVmaW5lZCcpIHBsYXkgPSB0cnVlO1xuICAgIHRocmVzaG9sZCA9IHRocmVzaG9sZCB8fCAtNjU7XG4gIH0gZWxzZSB7XG4gICAgLy9XZWJSVEMgU3RyZWFtXG4gICAgc291cmNlTm9kZSA9IGF1ZGlvQ29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZShzdHJlYW0pO1xuICAgIHRocmVzaG9sZCA9IHRocmVzaG9sZCB8fCAtNDU7XG4gIH1cblxuICBzb3VyY2VOb2RlLmNvbm5lY3QoYW5hbHlzZXIpO1xuICBpZiAocGxheSkgYW5hbHlzZXIuY29ubmVjdChhdWRpb0NvbnRleHQuZGVzdGluYXRpb24pO1xuXG4gIGhhcmtlci5zcGVha2luZyA9IGZhbHNlO1xuXG4gIGhhcmtlci5zZXRUaHJlc2hvbGQgPSBmdW5jdGlvbih0KSB7XG4gICAgdGhyZXNob2xkID0gdDtcbiAgfTtcblxuICBoYXJrZXIuc2V0SW50ZXJ2YWwgPSBmdW5jdGlvbihpKSB7XG4gICAgaW50ZXJ2YWwgPSBpO1xuICB9O1xuXG4gIC8vIFBvbGwgdGhlIGFuYWx5c2VyIG5vZGUgdG8gZGV0ZXJtaW5lIGlmIHNwZWFraW5nXG4gIC8vIGFuZCBlbWl0IGV2ZW50cyBpZiBjaGFuZ2VkXG4gIHZhciBsb29wZXIgPSBmdW5jdGlvbigpIHtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGN1cnJlbnRWb2x1bWUgPSBnZXRNYXhWb2x1bWUoYW5hbHlzZXIsIGZmdEJpbnMpO1xuXG4gICAgICBoYXJrZXIuZW1pdCgndm9sdW1lX2NoYW5nZScsIGN1cnJlbnRWb2x1bWUsIHRocmVzaG9sZCk7XG5cbiAgICAgIGlmIChjdXJyZW50Vm9sdW1lID4gdGhyZXNob2xkKSB7XG4gICAgICAgIGlmICghaGFya2VyLnNwZWFraW5nKSB7XG4gICAgICAgICAgaGFya2VyLnNwZWFraW5nID0gdHJ1ZTtcbiAgICAgICAgICBoYXJrZXIuZW1pdCgnc3BlYWtpbmcnKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGhhcmtlci5zcGVha2luZykge1xuICAgICAgICAgIGhhcmtlci5zcGVha2luZyA9IGZhbHNlO1xuICAgICAgICAgIGhhcmtlci5lbWl0KCdzdG9wcGVkX3NwZWFraW5nJyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbG9vcGVyKCk7XG4gICAgfSwgaW50ZXJ2YWwpO1xuICB9O1xuICBsb29wZXIoKTtcblxuXG4gIHJldHVybiBoYXJrZXI7XG59XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciB3ZWJydGMgPSByZXF1aXJlKCd3ZWJydGNzdXBwb3J0Jyk7XG52YXIgUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdydGNwZWVyY29ubmVjdGlvbicpO1xudmFyIFNKSiA9IHJlcXVpcmUoJ3NkcC1qaW5nbGUtanNvbicpO1xuXG5cbmZ1bmN0aW9uIEppbmdsZVBlZXJDb25uZWN0aW9uKGNvbmZpZywgY29uc3RyYWludHMpIHtcbiAgICB0aGlzLnNpZCA9ICcnO1xuICAgIHRoaXMuc2RwU2Vzc0lkID0gRGF0ZS5ub3coKTtcbiAgICB0aGlzLmlzSW5pdGlhdG9yID0gdHJ1ZTtcblxuICAgIHRoaXMubG9jYWxEZXNjcmlwdGlvbiA9IHtjb250ZW50czogW119O1xuICAgIHRoaXMucmVtb3RlRGVzY3JpcHRpb24gPSB7Y29udGVudHM6IFtdfTtcblxuICAgIHRoaXMuaWNlQ29uZmlncyA9IHt9O1xuXG4gICAgUGVlckNvbm5lY3Rpb24uY2FsbCh0aGlzLCBjb25maWcsIGNvbnN0cmFpbnRzKTtcbn1cblxuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShQZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogSmluZ2xlUGVlckNvbm5lY3Rpb25cbiAgICB9XG59KTtcblxuXG4vLyBHZW5lcmF0ZSBhbmQgZW1pdCBhbiBvZmZlciB3aXRoIHRoZSBnaXZlbiBjb25zdHJhaW50c1xuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLm9mZmVyID0gZnVuY3Rpb24gKGNvbnN0cmFpbnRzLCBjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgaGFzQ29uc3RyYWludHMgPSBhcmd1bWVudHMubGVuZ3RoID09PSAyO1xuICAgIHZhciBtZWRpYUNvbnN0cmFpbnRzID0gaGFzQ29uc3RyYWludHMgPyBjb25zdHJhaW50cyA6IHtcbiAgICAgICAgICAgIG1hbmRhdG9yeToge1xuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlQXVkaW86IHRydWUsXG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVWaWRlbzogdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIHZhciBjYWxsYmFjayA9IGhhc0NvbnN0cmFpbnRzID8gY2IgOiBjb25zdHJhaW50cztcblxuICAgIC8vIEFjdHVhbGx5IGdlbmVyYXRlIHRoZSBvZmZlclxuICAgIHRoaXMucGMuY3JlYXRlT2ZmZXIoXG4gICAgICAgIGZ1bmN0aW9uIChvZmZlcikge1xuICAgICAgICAgICAgb2ZmZXIuc2RwID0gc2VsZi5fYXBwbHlTZHBIYWNrKG9mZmVyLnNkcCk7XG4gICAgICAgICAgICBzZWxmLnBjLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpO1xuICAgICAgICAgICAgdmFyIGpzb24gPSBTSkoudG9TZXNzaW9uSlNPTihvZmZlci5zZHAsIHNlbGYuaXNJbml0aWF0b3IgPyAnaW5pdGlhdG9yJyA6ICdyZXNwb25kZXInKTtcbiAgICAgICAgICAgIGpzb24uc2lkID0gdGhpcy5zaWQ7XG4gICAgICAgICAgICBzZWxmLmxvY2FsRGVzY3JpcHRpb24gPSBqc29uO1xuXG4gICAgICAgICAgICAvLyBTYXZlIElDRSBjcmVkZW50aWFsc1xuICAgICAgICAgICAgXy5lYWNoKGpzb24uY29udGVudHMsIGZ1bmN0aW9uIChjb250ZW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKChjb250ZW50LnRyYW5zcG9ydCB8fCB7fSkudWZyYWcpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5pY2VDb25maWdzW2NvbnRlbnQubmFtZV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1ZnJhZzogKGNvbnRlbnQudHJhbnNwb3J0IHx8IHt9KS51ZnJhZyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHB3ZDogKGNvbnRlbnQudHJhbnNwb3J0IHx8IHt9KS5wd2RcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdmFyIGV4cGFuZGVkT2ZmZXIgPSB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ29mZmVyJyxcbiAgICAgICAgICAgICAgICBzZHA6IG9mZmVyLnNkcCxcbiAgICAgICAgICAgICAgICBqc29uOiBqc29uXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdvZmZlcicsIGV4cGFuZGVkT2ZmZXIpO1xuICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSBjYWxsYmFjayhudWxsLCBleHBhbmRlZE9mZmVyKTtcbiAgICAgICAgfSxcbiAgICAgICAgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XG4gICAgICAgICAgICBpZiAoY2FsbGJhY2spIGNhbGxiYWNrKGVycik7XG4gICAgICAgIH0sXG4gICAgICAgIG1lZGlhQ29uc3RyYWludHNcbiAgICApO1xufTtcblxuXG4vLyBQcm9jZXNzIGFuIGFuc3dlclxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmhhbmRsZUFuc3dlciA9IGZ1bmN0aW9uIChhbnN3ZXIsIGNiKSB7XG4gICAgY2IgPSBjYiB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgYW5zd2VyLnNkcCA9IFNKSi50b1Nlc3Npb25TRFAoYW5zd2VyLmpzb24sIHRoaXMuc2RwU2Vzc0lkKTtcbiAgICBzZWxmLnJlbW90ZURlc2NyaXB0aW9uID0gYW5zd2VyLmpzb247XG4gICAgdGhpcy5wYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihcbiAgICAgICAgbmV3IHdlYnJ0Yy5TZXNzaW9uRGVzY3JpcHRpb24oYW5zd2VyKSxcbiAgICAgICAgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgY2IobnVsbCk7XG4gICAgICAgIH0sXG4gICAgICAgIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNiKGVycik7XG4gICAgICAgIH1cbiAgICApO1xufTtcblxuLy8gSW50ZXJuYWwgY29kZSBzaGFyaW5nIGZvciB2YXJpb3VzIHR5cGVzIG9mIGFuc3dlciBtZXRob2RzXG5KaW5nbGVQZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuX2Fuc3dlciA9IGZ1bmN0aW9uIChvZmZlciwgY29uc3RyYWludHMsIGNiKSB7XG4gICAgY2IgPSBjYiB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgb2ZmZXIuc2RwID0gU0pKLnRvU2Vzc2lvblNEUChvZmZlci5qc29uLCBzZWxmLnNkcFNlc3NJZCk7XG4gICAgc2VsZi5yZW1vdGVEZXNjcmlwdGlvbiA9IG9mZmVyLmpzb247XG4gICAgdGhpcy5wYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihuZXcgd2VicnRjLlNlc3Npb25EZXNjcmlwdGlvbihvZmZlciksIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2VsZi5wYy5jcmVhdGVBbnN3ZXIoXG4gICAgICAgICAgICBmdW5jdGlvbiAoYW5zd2VyKSB7XG4gICAgICAgICAgICAgICAgYW5zd2VyLnNkcCA9IHNlbGYuX2FwcGx5U2RwSGFjayhhbnN3ZXIuc2RwKTtcbiAgICAgICAgICAgICAgICBzZWxmLnBjLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKTtcbiAgICAgICAgICAgICAgICB2YXIganNvbiA9IFNKSi50b1Nlc3Npb25KU09OKGFuc3dlci5zZHApO1xuICAgICAgICAgICAgICAgIGpzb24uc2lkID0gc2VsZi5zaWQ7XG4gICAgICAgICAgICAgICAgc2VsZi5sb2NhbERlc2NyaXB0aW9uID0ganNvbjtcbiAgICAgICAgICAgICAgICB2YXIgZXhwYW5kZWRBbnN3ZXIgPSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdhbnN3ZXInLFxuICAgICAgICAgICAgICAgICAgICBzZHA6IGFuc3dlci5zZHAsXG4gICAgICAgICAgICAgICAgICAgIGpzb246IGpzb25cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnYW5zd2VyJywgZXhwYW5kZWRBbnN3ZXIpO1xuICAgICAgICAgICAgICAgIGlmIChjYikgY2IobnVsbCwgZXhwYW5kZWRBbnN3ZXIpO1xuICAgICAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgICAgICAgICAgICAgIGlmIChjYikgY2IoZXJyKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjb25zdHJhaW50c1xuICAgICAgICApO1xuICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgY2IoZXJyKTtcbiAgICB9KTtcbn07XG5cblxuLy8gSW5pdCBhbmQgYWRkIGljZSBjYW5kaWRhdGUgb2JqZWN0IHdpdGggY29ycmVjdCBjb25zdHJ1Y3RvclxuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLnByb2Nlc3NJY2UgPSBmdW5jdGlvbiAodXBkYXRlLCBjYikge1xuICAgIGNiID0gY2IgfHwgZnVuY3Rpb24gKCkge307XG5cbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICB2YXIgY29udGVudE5hbWVzID0gXy5tYXAodGhpcy5yZW1vdGVEZXNjcmlwdGlvbi5jb250ZW50cywgZnVuY3Rpb24gKGNvbnRlbnQpIHtcbiAgICAgICAgcmV0dXJuIGNvbnRlbnQubmFtZTtcbiAgICB9KTtcblxuICAgIHZhciBjb250ZW50cyA9IHVwZGF0ZS5jb250ZW50cyB8fCBbXTtcbiAgICBjb250ZW50cy5mb3JFYWNoKGZ1bmN0aW9uIChjb250ZW50KSB7XG4gICAgICAgIHZhciB0cmFuc3BvcnQgPSBjb250ZW50LnRyYW5zcG9ydCB8fCB7fTtcbiAgICAgICAgdmFyIGNhbmRpZGF0ZXMgPSB0cmFuc3BvcnQuY2FuZGlkYXRlcyB8fCBbXTtcblxuICAgICAgICB2YXIgbWxpbmUgPSBjb250ZW50TmFtZXMuaW5kZXhPZihjb250ZW50Lm5hbWUpO1xuICAgICAgICB2YXIgbWlkID0gY29udGVudC5uYW1lO1xuXG4gICAgICAgIGNhbmRpZGF0ZXMuZm9yRWFjaChmdW5jdGlvbiAoY2FuZGlkYXRlKSB7XG4gICAgICAgICAgICB2YXIgaWNlQ2FuZGlkYXRlID0gU0pKLnRvQ2FuZGlkYXRlU0RQKGNhbmRpZGF0ZSkgKyAnXFxyXFxuJztcbiAgICAgICAgICAgIHZhciBpY2VEYXRhID0ge1xuICAgICAgICAgICAgICAgIGNhbmRpZGF0ZTogaWNlQ2FuZGlkYXRlLFxuICAgICAgICAgICAgICAgIHNkcE1MaW5lSW5kZXg6IG1saW5lLFxuICAgICAgICAgICAgICAgIHNkcE1pZDogbWlkXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgc2VsZi5wYy5hZGRJY2VDYW5kaWRhdGUobmV3IHdlYnJ0Yy5JY2VDYW5kaWRhdGUoaWNlRGF0YSkpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBjYigpO1xufTtcblxuXG4vLyBJbnRlcm5hbCBtZXRob2QgZm9yIGVtaXR0aW5nIGljZSBjYW5kaWRhdGVzIG9uIG91ciBwZWVyIG9iamVjdFxuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9vbkljZSA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoZXZlbnQuY2FuZGlkYXRlKSB7XG4gICAgICAgIHZhciBpY2UgPSBldmVudC5jYW5kaWRhdGU7XG5cbiAgICAgICAgaWYgKCFzZWxmLmljZUNvbmZpZ3NbaWNlLnNkcE1pZF0pIHtcbiAgICAgICAgICAgIC8vIFNhdmUgSUNFIGNyZWRlbnRpYWxzXG4gICAgICAgICAgICB2YXIganNvbiA9IFNKSi50b1Nlc3Npb25KU09OKHNlbGYucGMubG9jYWxEZXNjcmlwdGlvbi5zZHAsIHNlbGYuaXNJbml0aWF0b3IgPyAnaW5pdGlhdG9yJyA6ICdyZXNwb25kZXInKTtcbiAgICAgICAgICAgIF8uZWFjaChqc29uLmNvbnRlbnRzLCBmdW5jdGlvbiAoY29udGVudCkge1xuICAgICAgICAgICAgICAgIGlmICgoY29udGVudC50cmFuc3BvcnQgfHwge30pLnVmcmFnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuaWNlQ29uZmlnc1tjb250ZW50Lm5hbWVdID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdWZyYWc6IChjb250ZW50LnRyYW5zcG9ydCB8fCB7fSkudWZyYWcsXG4gICAgICAgICAgICAgICAgICAgICAgICBwd2Q6IChjb250ZW50LnRyYW5zcG9ydCB8fCB7fSkucHdkXG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmVtaXQoJ2ljZScsIHtcbiAgICAgICAgICAgIGNvbnRlbnRzOiBbe1xuICAgICAgICAgICAgICAgIG5hbWU6IGljZS5zZHBNaWQsXG4gICAgICAgICAgICAgICAgY3JlYXRvcjogc2VsZi5pc0luaXRpYXRvciA/ICdpbml0aWF0b3InIDogJ3Jlc3BvbmRlcicsXG4gICAgICAgICAgICAgICAgdHJhbnNwb3J0OiB7XG4gICAgICAgICAgICAgICAgICAgIHRyYW5zVHlwZTogJ2ljZVVkcCcsXG4gICAgICAgICAgICAgICAgICAgIHVmcmFnOiBzZWxmLmljZUNvbmZpZ3NbaWNlLnNkcE1pZF0udWZyYWcsXG4gICAgICAgICAgICAgICAgICAgIHB3ZDogc2VsZi5pY2VDb25maWdzW2ljZS5zZHBNaWRdLnB3ZCxcbiAgICAgICAgICAgICAgICAgICAgY2FuZGlkYXRlczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgU0pKLnRvQ2FuZGlkYXRlSlNPTihpY2UuY2FuZGlkYXRlKVxuICAgICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfV1cbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5lbWl0KCdlbmRPZkNhbmRpZGF0ZXMnKTtcbiAgICB9XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gSmluZ2xlUGVlckNvbm5lY3Rpb247XG4iLCJ2YXIgV2lsZEVtaXR0ZXIgPSByZXF1aXJlKCd3aWxkZW1pdHRlcicpO1xudmFyIHdlYnJ0YyA9IHJlcXVpcmUoJ3dlYnJ0Y3N1cHBvcnQnKTtcblxuXG5mdW5jdGlvbiBQZWVyQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKSB7XG4gICAgdmFyIGl0ZW07XG4gICAgdGhpcy5wYyA9IG5ldyB3ZWJydGMuUGVlckNvbm5lY3Rpb24oY29uZmlnLCBjb25zdHJhaW50cyk7XG4gICAgV2lsZEVtaXR0ZXIuY2FsbCh0aGlzKTtcblxuICAgIC8vIHByb3h5IHNvbWUgZXZlbnRzIGRpcmVjdGx5XG4gICAgdGhpcy5wYy5vbnJlbW92ZXN0cmVhbSA9IHRoaXMuZW1pdC5iaW5kKHRoaXMsICdyZW1vdmVTdHJlYW0nKTtcbiAgICB0aGlzLnBjLm9ubmVnb3RpYXRpb25uZWVkZWQgPSB0aGlzLmVtaXQuYmluZCh0aGlzLCAnbmVnb3RpYXRpb25OZWVkZWQnKTtcbiAgICB0aGlzLnBjLm9uaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlID0gdGhpcy5lbWl0LmJpbmQodGhpcywgJ2ljZUNvbm5lY3Rpb25TdGF0ZUNoYW5nZScpO1xuICAgIHRoaXMucGMub25zaWduYWxpbmdzdGF0ZWNoYW5nZSA9IHRoaXMuZW1pdC5iaW5kKHRoaXMsICdzaWduYWxpbmdTdGF0ZUNoYW5nZScpO1xuXG4gICAgLy8gaGFuZGxlIGluY29taW5nIGljZSBhbmQgZGF0YSBjaGFubmVsIGV2ZW50c1xuICAgIHRoaXMucGMub25hZGRzdHJlYW0gPSB0aGlzLl9vbkFkZFN0cmVhbS5iaW5kKHRoaXMpO1xuICAgIHRoaXMucGMub25pY2VjYW5kaWRhdGUgPSB0aGlzLl9vbkljZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMucGMub25kYXRhY2hhbm5lbCA9IHRoaXMuX29uRGF0YUNoYW5uZWwuYmluZCh0aGlzKTtcblxuICAgIC8vIHdoZXRoZXIgdG8gdXNlIFNEUCBoYWNrIGZvciBmYXN0ZXIgZGF0YSB0cmFuc2ZlclxuICAgIHRoaXMuY29uZmlnID0ge1xuICAgICAgICBkZWJ1ZzogZmFsc2UsXG4gICAgICAgIHNkcEhhY2s6IHRydWVcbiAgICB9O1xuXG4gICAgLy8gYXBwbHkgb3VyIGNvbmZpZ1xuICAgIGZvciAoaXRlbSBpbiBjb25maWcpIHtcbiAgICAgICAgdGhpcy5jb25maWdbaXRlbV0gPSBjb25maWdbaXRlbV07XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29uZmlnLmRlYnVnKSB7XG4gICAgICAgIHRoaXMub24oJyonLCBmdW5jdGlvbiAoZXZlbnROYW1lLCBldmVudCkge1xuICAgICAgICAgICAgdmFyIGxvZ2dlciA9IGNvbmZpZy5sb2dnZXIgfHwgY29uc29sZTtcbiAgICAgICAgICAgIGxvZ2dlci5sb2coJ1BlZXJDb25uZWN0aW9uIGV2ZW50OicsIGFyZ3VtZW50cyk7XG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShXaWxkRW1pdHRlci5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogUGVlckNvbm5lY3Rpb25cbiAgICB9XG59KTtcblxuLy8gQWRkIGEgc3RyZWFtIHRvIHRoZSBwZWVyIGNvbm5lY3Rpb24gb2JqZWN0XG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuYWRkU3RyZWFtID0gZnVuY3Rpb24gKHN0cmVhbSkge1xuICAgIHRoaXMubG9jYWxTdHJlYW0gPSBzdHJlYW07XG4gICAgdGhpcy5wYy5hZGRTdHJlYW0oc3RyZWFtKTtcbn07XG5cblxuLy8gSW5pdCBhbmQgYWRkIGljZSBjYW5kaWRhdGUgb2JqZWN0IHdpdGggY29ycmVjdCBjb25zdHJ1Y3RvclxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLnByb2Nlc3NJY2UgPSBmdW5jdGlvbiAoY2FuZGlkYXRlKSB7XG4gICAgdGhpcy5wYy5hZGRJY2VDYW5kaWRhdGUobmV3IHdlYnJ0Yy5JY2VDYW5kaWRhdGUoY2FuZGlkYXRlKSk7XG59O1xuXG4vLyBHZW5lcmF0ZSBhbmQgZW1pdCBhbiBvZmZlciB3aXRoIHRoZSBnaXZlbiBjb25zdHJhaW50c1xuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLm9mZmVyID0gZnVuY3Rpb24gKGNvbnN0cmFpbnRzLCBjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgaGFzQ29uc3RyYWludHMgPSBhcmd1bWVudHMubGVuZ3RoID09PSAyO1xuICAgIHZhciBtZWRpYUNvbnN0cmFpbnRzID0gaGFzQ29uc3RyYWludHMgPyBjb25zdHJhaW50cyA6IHtcbiAgICAgICAgICAgIG1hbmRhdG9yeToge1xuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlQXVkaW86IHRydWUsXG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVWaWRlbzogdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIHZhciBjYWxsYmFjayA9IGhhc0NvbnN0cmFpbnRzID8gY2IgOiBjb25zdHJhaW50cztcblxuICAgIC8vIEFjdHVhbGx5IGdlbmVyYXRlIHRoZSBvZmZlclxuICAgIHRoaXMucGMuY3JlYXRlT2ZmZXIoXG4gICAgICAgIGZ1bmN0aW9uIChvZmZlcikge1xuICAgICAgICAgICAgb2ZmZXIuc2RwID0gc2VsZi5fYXBwbHlTZHBIYWNrKG9mZmVyLnNkcCk7XG4gICAgICAgICAgICBzZWxmLnBjLnNldExvY2FsRGVzY3JpcHRpb24ob2ZmZXIpO1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdvZmZlcicsIG9mZmVyKTtcbiAgICAgICAgICAgIGlmIChjYWxsYmFjaykgY2FsbGJhY2sobnVsbCwgb2ZmZXIpO1xuICAgICAgICB9LFxuICAgICAgICBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ2Vycm9yJywgZXJyKTtcbiAgICAgICAgICAgIGlmIChjYWxsYmFjaykgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgfSxcbiAgICAgICAgbWVkaWFDb25zdHJhaW50c1xuICAgICk7XG59O1xuXG4vLyBBbnN3ZXIgYW4gb2ZmZXIgd2l0aCBhdWRpbyBvbmx5XG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuYW5zd2VyQXVkaW9Pbmx5ID0gZnVuY3Rpb24gKG9mZmVyLCBjYikge1xuICAgIHZhciBtZWRpYUNvbnN0cmFpbnRzID0ge1xuICAgICAgICAgICAgbWFuZGF0b3J5OiB7XG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiBmYWxzZVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIHRoaXMuX2Fuc3dlcihvZmZlciwgbWVkaWFDb25zdHJhaW50cywgY2IpO1xufTtcblxuLy8gQW5zd2VyIGFuIG9mZmVyIHdpdGhvdXQgb2ZmZXJpbmcgdG8gcmVjaWV2ZVxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmFuc3dlckJyb2FkY2FzdE9ubHkgPSBmdW5jdGlvbiAob2ZmZXIsIGNiKSB7XG4gICAgdmFyIG1lZGlhQ29uc3RyYWludHMgPSB7XG4gICAgICAgICAgICBtYW5kYXRvcnk6IHtcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZUF1ZGlvOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiBmYWxzZVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIHRoaXMuX2Fuc3dlcihvZmZlciwgbWVkaWFDb25zdHJhaW50cywgY2IpO1xufTtcblxuLy8gQW5zd2VyIGFuIG9mZmVyIHdpdGggZ2l2ZW4gY29uc3RyYWludHMgZGVmYXVsdCBpcyBhdWRpby92aWRlb1xuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmFuc3dlciA9IGZ1bmN0aW9uIChvZmZlciwgY29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBoYXNDb25zdHJhaW50cyA9IGFyZ3VtZW50cy5sZW5ndGggPT09IDM7XG4gICAgdmFyIGNhbGxiYWNrID0gaGFzQ29uc3RyYWludHMgPyBjYiA6IGNvbnN0cmFpbnRzO1xuICAgIHZhciBtZWRpYUNvbnN0cmFpbnRzID0gaGFzQ29uc3RyYWludHMgPyBjb25zdHJhaW50cyA6IHtcbiAgICAgICAgICAgIG1hbmRhdG9yeToge1xuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlQXVkaW86IHRydWUsXG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVWaWRlbzogdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuXG4gICAgdGhpcy5fYW5zd2VyKG9mZmVyLCBtZWRpYUNvbnN0cmFpbnRzLCBjYWxsYmFjayk7XG59O1xuXG4vLyBQcm9jZXNzIGFuIGFuc3dlclxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmhhbmRsZUFuc3dlciA9IGZ1bmN0aW9uIChhbnN3ZXIpIHtcbiAgICB0aGlzLnBjLnNldFJlbW90ZURlc2NyaXB0aW9uKG5ldyB3ZWJydGMuU2Vzc2lvbkRlc2NyaXB0aW9uKGFuc3dlcikpO1xufTtcblxuLy8gQ2xvc2UgdGhlIHBlZXIgY29ubmVjdGlvblxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmNsb3NlID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMucGMuY2xvc2UoKTtcbiAgICB0aGlzLmVtaXQoJ2Nsb3NlJyk7XG59O1xuXG4vLyBJbnRlcm5hbCBjb2RlIHNoYXJpbmcgZm9yIHZhcmlvdXMgdHlwZXMgb2YgYW5zd2VyIG1ldGhvZHNcblBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5fYW5zd2VyID0gZnVuY3Rpb24gKG9mZmVyLCBjb25zdHJhaW50cywgY2IpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdGhpcy5wYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihuZXcgd2VicnRjLlNlc3Npb25EZXNjcmlwdGlvbihvZmZlcikpO1xuICAgIHRoaXMucGMuY3JlYXRlQW5zd2VyKFxuICAgICAgICBmdW5jdGlvbiAoYW5zd2VyKSB7XG4gICAgICAgICAgICBhbnN3ZXIuc2RwID0gc2VsZi5fYXBwbHlTZHBIYWNrKGFuc3dlci5zZHApO1xuICAgICAgICAgICAgc2VsZi5wYy5zZXRMb2NhbERlc2NyaXB0aW9uKGFuc3dlcik7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ2Fuc3dlcicsIGFuc3dlcik7XG4gICAgICAgICAgICBpZiAoY2IpIGNiKG51bGwsIGFuc3dlcik7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgICAgICAgICAgaWYgKGNiKSBjYihlcnIpO1xuICAgICAgICB9LFxuICAgICAgICBjb25zdHJhaW50c1xuICAgICk7XG59O1xuXG4vLyBJbnRlcm5hbCBtZXRob2QgZm9yIGVtaXR0aW5nIGljZSBjYW5kaWRhdGVzIG9uIG91ciBwZWVyIG9iamVjdFxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9vbkljZSA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIGlmIChldmVudC5jYW5kaWRhdGUpIHtcbiAgICAgICAgdGhpcy5lbWl0KCdpY2UnLCBldmVudC5jYW5kaWRhdGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuZW1pdCgnZW5kT2ZDYW5kaWRhdGVzJyk7XG4gICAgfVxufTtcblxuLy8gSW50ZXJuYWwgbWV0aG9kIGZvciBwcm9jZXNzaW5nIGEgbmV3IGRhdGEgY2hhbm5lbCBiZWluZyBhZGRlZCBieSB0aGVcbi8vIG90aGVyIHBlZXIuXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuX29uRGF0YUNoYW5uZWwgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICB0aGlzLmVtaXQoJ2FkZENoYW5uZWwnLCBldmVudC5jaGFubmVsKTtcbn07XG5cbi8vIEludGVybmFsIGhhbmRsaW5nIG9mIGFkZGluZyBzdHJlYW1cblBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5fb25BZGRTdHJlYW0gPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICB0aGlzLnJlbW90ZVN0cmVhbSA9IGV2ZW50LnN0cmVhbTtcbiAgICB0aGlzLmVtaXQoJ2FkZFN0cmVhbScsIGV2ZW50KTtcbn07XG5cbi8vIFNEUCBoYWNrIGZvciBpbmNyZWFzaW5nIEFTIChhcHBsaWNhdGlvbiBzcGVjaWZpYykgZGF0YSB0cmFuc2ZlciBzcGVlZCBhbGxvd2VkIGluIGNocm9tZVxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9hcHBseVNkcEhhY2sgPSBmdW5jdGlvbiAoc2RwKSB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5zZHBIYWNrKSByZXR1cm4gc2RwO1xuICAgIHZhciBwYXJ0cyA9IHNkcC5zcGxpdCgnYj1BUzozMCcpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgLy8gaW5jcmVhc2UgbWF4IGRhdGEgdHJhbnNmZXIgYmFuZHdpZHRoIHRvIDEwMCBNYnBzXG4gICAgICAgIHJldHVybiBwYXJ0c1swXSArICdiPUFTOjEwMjQwMCcgKyBwYXJ0c1sxXTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gc2RwO1xuICAgIH1cbn07XG5cbi8vIENyZWF0ZSBhIGRhdGEgY2hhbm5lbCBzcGVjIHJlZmVyZW5jZTpcbi8vIGh0dHA6Ly9kZXYudzMub3JnLzIwMTEvd2VicnRjL2VkaXRvci93ZWJydGMuaHRtbCNpZGwtZGVmLVJUQ0RhdGFDaGFubmVsSW5pdFxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmNyZWF0ZURhdGFDaGFubmVsID0gZnVuY3Rpb24gKG5hbWUsIG9wdHMpIHtcbiAgICBvcHRzIHx8IChvcHRzID0ge30pO1xuICAgIHZhciByZWxpYWJsZSA9ICEhb3B0cy5yZWxpYWJsZTtcbiAgICB2YXIgcHJvdG9jb2wgPSBvcHRzLnByb3RvY29sIHx8ICd0ZXh0L3BsYWluJztcbiAgICB2YXIgbmVnb3RpYXRlZCA9ICEhKG9wdHMubmVnb3RpYXRlZCB8fCBvcHRzLnByZXNldCk7XG4gICAgdmFyIHNldHRpbmdzO1xuICAgIHZhciBjaGFubmVsO1xuICAgIC8vIGZpcmVmb3ggaXMgYSBiaXQgbW9yZSBmaW5uaWNreVxuICAgIGlmICh3ZWJydGMucHJlZml4ID09PSAnbW96Jykge1xuICAgICAgICBpZiAocmVsaWFibGUpIHtcbiAgICAgICAgICAgIHNldHRpbmdzID0ge1xuICAgICAgICAgICAgICAgIHByb3RvY29sOiBwcm90b2NvbCxcbiAgICAgICAgICAgICAgICBwcmVzZXQ6IG5lZ290aWF0ZWQsXG4gICAgICAgICAgICAgICAgc3RyZWFtOiBuYW1lXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0dGluZ3MgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBjaGFubmVsID0gdGhpcy5wYy5jcmVhdGVEYXRhQ2hhbm5lbChuYW1lLCBzZXR0aW5ncyk7XG4gICAgICAgIGNoYW5uZWwuYmluYXJ5VHlwZSA9ICdibG9iJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBpZiAocmVsaWFibGUpIHtcbiAgICAgICAgICAgIHNldHRpbmdzID0ge1xuICAgICAgICAgICAgICAgIHJlbGlhYmxlOiB0cnVlXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0dGluZ3MgPSB7cmVsaWFibGU6IGZhbHNlfTtcbiAgICAgICAgfVxuICAgICAgICBjaGFubmVsID0gdGhpcy5wYy5jcmVhdGVEYXRhQ2hhbm5lbChuYW1lLCBzZXR0aW5ncyk7XG4gICAgfVxuICAgIHJldHVybiBjaGFubmVsO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBQZWVyQ29ubmVjdGlvbjtcbiIsInZhciBzdXBwb3J0ID0gcmVxdWlyZSgnd2VicnRjc3VwcG9ydCcpO1xuXG5cbmZ1bmN0aW9uIEdhaW5Db250cm9sbGVyKHN0cmVhbSkge1xuICAgIHRoaXMuc3VwcG9ydCA9IHN1cHBvcnQud2ViQXVkaW8gJiYgc3VwcG9ydC5tZWRpYVN0cmVhbTtcblxuICAgIC8vIHNldCBvdXIgc3RhcnRpbmcgdmFsdWVcbiAgICB0aGlzLmdhaW4gPSAxO1xuXG4gICAgaWYgKHRoaXMuc3VwcG9ydCkge1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuY29udGV4dCA9IG5ldyBzdXBwb3J0LkF1ZGlvQ29udGV4dCgpO1xuICAgICAgICB0aGlzLm1pY3JvcGhvbmUgPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKHN0cmVhbSk7XG4gICAgICAgIHRoaXMuZ2FpbkZpbHRlciA9IGNvbnRleHQuY3JlYXRlR2FpbigpO1xuICAgICAgICB0aGlzLmRlc3RpbmF0aW9uID0gY29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbURlc3RpbmF0aW9uKCk7XG4gICAgICAgIHRoaXMub3V0cHV0U3RyZWFtID0gdGhpcy5kZXN0aW5hdGlvbi5zdHJlYW07XG4gICAgICAgIHRoaXMubWljcm9waG9uZS5jb25uZWN0KHRoaXMuZ2FpbkZpbHRlcik7XG4gICAgICAgIHRoaXMuZ2FpbkZpbHRlci5jb25uZWN0KHRoaXMuZGVzdGluYXRpb24pO1xuICAgICAgICBzdHJlYW0ucmVtb3ZlVHJhY2soc3RyZWFtLmdldEF1ZGlvVHJhY2tzKClbMF0pO1xuICAgICAgICBzdHJlYW0uYWRkVHJhY2sodGhpcy5vdXRwdXRTdHJlYW0uZ2V0QXVkaW9UcmFja3MoKVswXSk7XG4gICAgfVxuICAgIHRoaXMuc3RyZWFtID0gc3RyZWFtO1xufVxuXG4vLyBzZXR0aW5nXG5HYWluQ29udHJvbGxlci5wcm90b3R5cGUuc2V0R2FpbiA9IGZ1bmN0aW9uICh2YWwpIHtcbiAgICAvLyBjaGVjayBmb3Igc3VwcG9ydFxuICAgIGlmICghdGhpcy5zdXBwb3J0KSByZXR1cm47XG4gICAgdGhpcy5nYWluRmlsdGVyLmdhaW4udmFsdWUgPSB2YWw7XG4gICAgdGhpcy5nYWluID0gdmFsO1xufTtcblxuR2FpbkNvbnRyb2xsZXIucHJvdG90eXBlLmdldEdhaW4gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMuZ2Fpbjtcbn07XG5cbkdhaW5Db250cm9sbGVyLnByb3RvdHlwZS5vZmYgPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMuc2V0R2FpbigwKTtcbn07XG5cbkdhaW5Db250cm9sbGVyLnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLnNldEdhaW4oMSk7XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gR2FpbkNvbnRyb2xsZXI7XG4iLCIvLyBjcmVhdGVkIGJ5IEBIZW5yaWtKb3JldGVnXG52YXIgUEMgPSB3aW5kb3cubW96UlRDUGVlckNvbm5lY3Rpb24gfHwgd2luZG93LndlYmtpdFJUQ1BlZXJDb25uZWN0aW9uIHx8IHdpbmRvdy5SVENQZWVyQ29ubmVjdGlvbjtcbnZhciBJY2VDYW5kaWRhdGUgPSB3aW5kb3cubW96UlRDSWNlQ2FuZGlkYXRlIHx8IHdpbmRvdy5SVENJY2VDYW5kaWRhdGU7XG52YXIgU2Vzc2lvbkRlc2NyaXB0aW9uID0gd2luZG93Lm1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiB8fCB3aW5kb3cuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xudmFyIHByZWZpeCA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAod2luZG93Lm1velJUQ1BlZXJDb25uZWN0aW9uKSB7XG4gICAgICAgIHJldHVybiAnbW96JztcbiAgICB9IGVsc2UgaWYgKHdpbmRvdy53ZWJraXRSVENQZWVyQ29ubmVjdGlvbikge1xuICAgICAgICByZXR1cm4gJ3dlYmtpdCc7XG4gICAgfVxufSgpO1xudmFyIE1lZGlhU3RyZWFtID0gd2luZG93LndlYmtpdE1lZGlhU3RyZWFtIHx8IHdpbmRvdy5NZWRpYVN0cmVhbTtcbnZhciBzY3JlZW5TaGFyaW5nID0gbmF2aWdhdG9yLnVzZXJBZ2VudC5tYXRjaCgnQ2hyb21lJykgJiYgcGFyc2VJbnQobmF2aWdhdG9yLnVzZXJBZ2VudC5tYXRjaCgvQ2hyb21lXFwvKC4qKSAvKVsxXSwgMTApID49IDI2O1xudmFyIEF1ZGlvQ29udGV4dCA9IHdpbmRvdy53ZWJraXRBdWRpb0NvbnRleHQgfHwgd2luZG93LkF1ZGlvQ29udGV4dDtcblxuLy8gZXhwb3J0IHN1cHBvcnQgZmxhZ3MgYW5kIGNvbnN0cnVjdG9ycy5wcm90b3R5cGUgJiYgUENcbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIHN1cHBvcnQ6ICEhUEMsXG4gICAgZGF0YUNoYW5uZWw6ICEhKFBDICYmIFBDLnByb3RvdHlwZSAmJiBQQy5wcm90b3R5cGUuY3JlYXRlRGF0YUNoYW5uZWwpLFxuICAgIHByZWZpeDogcHJlZml4LFxuICAgIHdlYkF1ZGlvOiAhIShBdWRpb0NvbnRleHQgJiYgQXVkaW9Db250ZXh0LnByb3RvdHlwZS5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSksXG4gICAgbWVkaWFTdHJlYW06ICEhKE1lZGlhU3RyZWFtICYmIE1lZGlhU3RyZWFtLnByb3RvdHlwZS5yZW1vdmVUcmFjayksXG4gICAgc2NyZWVuU2hhcmluZzogc2NyZWVuU2hhcmluZyxcbiAgICBBdWRpb0NvbnRleHQ6IEF1ZGlvQ29udGV4dCxcbiAgICBQZWVyQ29ubmVjdGlvbjogUEMsXG4gICAgU2Vzc2lvbkRlc2NyaXB0aW9uOiBTZXNzaW9uRGVzY3JpcHRpb24sXG4gICAgSWNlQ2FuZGlkYXRlOiBJY2VDYW5kaWRhdGVcbn07XG4iLCJ2YXIgbWV0aG9kcyA9IFwiYXNzZXJ0LGNvdW50LGRlYnVnLGRpcixkaXJ4bWwsZXJyb3IsZXhjZXB0aW9uLGdyb3VwLGdyb3VwQ29sbGFwc2VkLGdyb3VwRW5kLGluZm8sbG9nLG1hcmtUaW1lbGluZSxwcm9maWxlLHByb2ZpbGVFbmQsdGltZSx0aW1lRW5kLHRyYWNlLHdhcm5cIi5zcGxpdChcIixcIik7XG52YXIgbCA9IG1ldGhvZHMubGVuZ3RoO1xudmFyIGZuID0gZnVuY3Rpb24gKCkge307XG52YXIgbW9ja2NvbnNvbGUgPSB7fTtcblxud2hpbGUgKGwtLSkge1xuICAgIG1vY2tjb25zb2xlW21ldGhvZHNbbF1dID0gZm47XG59XG5cbm1vZHVsZS5leHBvcnRzID0gbW9ja2NvbnNvbGU7XG4iLCJ2YXIgdG9zZHAgPSByZXF1aXJlKCcuL2xpYi90b3NkcCcpO1xudmFyIHRvanNvbiA9IHJlcXVpcmUoJy4vbGliL3RvanNvbicpO1xuXG5cbmV4cG9ydHMudG9TZXNzaW9uU0RQID0gdG9zZHAudG9TZXNzaW9uU0RQO1xuZXhwb3J0cy50b01lZGlhU0RQID0gdG9zZHAudG9NZWRpYVNEUDtcbmV4cG9ydHMudG9DYW5kaWRhdGVTRFAgPSB0b3NkcC50b0NhbmRpZGF0ZVNEUDtcblxuZXhwb3J0cy50b1Nlc3Npb25KU09OID0gdG9qc29uLnRvU2Vzc2lvbkpTT047XG5leHBvcnRzLnRvTWVkaWFKU09OID0gdG9qc29uLnRvTWVkaWFKU09OO1xuZXhwb3J0cy50b0NhbmRpZGF0ZUpTT04gPSB0b2pzb24udG9DYW5kaWRhdGVKU09OO1xuIiwiZXhwb3J0cy5saW5lcyA9IGZ1bmN0aW9uIChzZHApIHtcbiAgICByZXR1cm4gc2RwLnNwbGl0KCdcXHJcXG4nKS5maWx0ZXIoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgcmV0dXJuIGxpbmUubGVuZ3RoID4gMDtcbiAgICB9KTtcbn07XG5cbmV4cG9ydHMuZmluZExpbmUgPSBmdW5jdGlvbiAocHJlZml4LCBtZWRpYUxpbmVzLCBzZXNzaW9uTGluZXMpIHtcbiAgICB2YXIgcHJlZml4TGVuZ3RoID0gcHJlZml4Lmxlbmd0aDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1lZGlhTGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKG1lZGlhTGluZXNbaV0uc3Vic3RyKDAsIHByZWZpeExlbmd0aCkgPT09IHByZWZpeCkge1xuICAgICAgICAgICAgcmV0dXJuIG1lZGlhTGluZXNbaV07XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8gQ29udGludWUgc2VhcmNoaW5nIGluIHBhcmVudCBzZXNzaW9uIHNlY3Rpb25cbiAgICBpZiAoIXNlc3Npb25MaW5lcykge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBzZXNzaW9uTGluZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgaWYgKHNlc3Npb25MaW5lc1tqXS5zdWJzdHIoMCwgcHJlZml4TGVuZ3RoKSA9PT0gcHJlZml4KSB7XG4gICAgICAgICAgICByZXR1cm4gc2Vzc2lvbkxpbmVzW2pdO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xufTtcblxuZXhwb3J0cy5maW5kTGluZXMgPSBmdW5jdGlvbiAocHJlZml4LCBtZWRpYUxpbmVzLCBzZXNzaW9uTGluZXMpIHtcbiAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgIHZhciBwcmVmaXhMZW5ndGggPSBwcmVmaXgubGVuZ3RoO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbWVkaWFMaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAobWVkaWFMaW5lc1tpXS5zdWJzdHIoMCwgcHJlZml4TGVuZ3RoKSA9PT0gcHJlZml4KSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2gobWVkaWFMaW5lc1tpXSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJlc3VsdHMubGVuZ3RoIHx8ICFzZXNzaW9uTGluZXMpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgc2Vzc2lvbkxpbmVzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGlmIChzZXNzaW9uTGluZXNbal0uc3Vic3RyKDAsIHByZWZpeExlbmd0aCkgPT09IHByZWZpeCkge1xuICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHNlc3Npb25MaW5lc1tqXSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG59O1xuXG5leHBvcnRzLm1saW5lID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgICB2YXIgcGFydHMgPSBsaW5lLnN1YnN0cigyKS5zcGxpdCgnICcpO1xuICAgIHZhciBwYXJzZWQgPSB7XG4gICAgICAgIG1lZGlhOiBwYXJ0c1swXSxcbiAgICAgICAgcG9ydDogcGFydHNbMV0sXG4gICAgICAgIHByb3RvOiBwYXJ0c1syXSxcbiAgICAgICAgZm9ybWF0czogW11cbiAgICB9O1xuICAgIGZvciAodmFyIGkgPSAzOyBpIDwgcGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHBhcnRzW2ldKSB7XG4gICAgICAgICAgICBwYXJzZWQuZm9ybWF0cy5wdXNoKHBhcnRzW2ldKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy5ydHBtYXAgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDkpLnNwbGl0KCcgJyk7XG4gICAgdmFyIHBhcnNlZCA9IHtcbiAgICAgICAgaWQ6IHBhcnRzLnNoaWZ0KClcbiAgICB9O1xuXG4gICAgcGFydHMgPSBwYXJ0c1swXS5zcGxpdCgnLycpO1xuXG4gICAgcGFyc2VkLm5hbWUgPSBwYXJ0c1swXTtcbiAgICBwYXJzZWQuY2xvY2tyYXRlID0gcGFydHNbMV07XG4gICAgcGFyc2VkLmNoYW5uZWxzID0gcGFydHMubGVuZ3RoID09IDMgPyBwYXJ0c1syXSA6ICcxJztcbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy5mbXRwID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgICB2YXIga3YsIGtleSwgdmFsdWU7XG4gICAgdmFyIHBhcnRzID0gbGluZS5zdWJzdHIobGluZS5pbmRleE9mKCcgJykgKyAxKS5zcGxpdCgnOycpO1xuICAgIHZhciBwYXJzZWQgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGt2ID0gcGFydHNbaV0uc3BsaXQoJz0nKTtcbiAgICAgICAga2V5ID0ga3ZbMF0udHJpbSgpO1xuICAgICAgICB2YWx1ZSA9IGt2WzFdO1xuICAgICAgICBpZiAoa2V5ICYmIHZhbHVlKSB7XG4gICAgICAgICAgICBwYXJzZWQucHVzaCh7a2V5OiBrZXksIHZhbHVlOiB2YWx1ZX0pO1xuICAgICAgICB9IGVsc2UgaWYgKGtleSkge1xuICAgICAgICAgICAgcGFyc2VkLnB1c2goe2tleTogJycsIHZhbHVlOiBrZXl9KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy5jcnlwdG8gPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDkpLnNwbGl0KCcgJyk7XG4gICAgdmFyIHBhcnNlZCA9IHtcbiAgICAgICAgdGFnOiBwYXJ0c1swXSxcbiAgICAgICAgY2lwaGVyU3VpdGU6IHBhcnRzWzFdLFxuICAgICAgICBrZXlQYXJhbXM6IHBhcnRzWzJdLFxuICAgICAgICBzZXNzaW9uUGFyYW1zOiBwYXJ0cy5zbGljZSgzKS5qb2luKCcgJylcbiAgICB9O1xuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLmZpbmdlcnByaW50ID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgICB2YXIgcGFydHMgPSBsaW5lLnN1YnN0cigxNCkuc3BsaXQoJyAnKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBoYXNoOiBwYXJ0c1swXSxcbiAgICAgICAgdmFsdWU6IHBhcnRzWzFdXG4gICAgfTtcbn07XG5cbmV4cG9ydHMuZXh0bWFwID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgICB2YXIgcGFydHMgPSBsaW5lLnN1YnN0cig5KS5zcGxpdCgnICcpO1xuICAgIHZhciBwYXJzZWQgPSB7fTtcblxuICAgIHZhciBpZHBhcnQgPSBwYXJ0cy5zaGlmdCgpO1xuICAgIHZhciBzcCA9IGlkcGFydC5pbmRleE9mKCcvJyk7XG4gICAgaWYgKHNwID49IDApIHtcbiAgICAgICAgcGFyc2VkLmlkID0gaWRwYXJ0LnN1YnN0cigwLCBzcCk7XG4gICAgICAgIHBhcnNlZC5zZW5kZXJzID0gaWRwYXJ0LnN1YnN0cihzcCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcGFyc2VkLmlkID0gaWRwYXJ0O1xuICAgICAgICBwYXJzZWQuc2VuZGVycyA9ICdzZW5kcmVjdic7XG4gICAgfVxuXG4gICAgcGFyc2VkLnVyaSA9IHBhcnRzLnNoaWZ0KCk7XG5cbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy5ydGNwZmIgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDEwKS5zcGxpdCgnICcpO1xuICAgIHZhciBwYXJzZWQgPSB7fTtcbiAgICBwYXJzZWQuaWQgPSBwYXJ0cy5zaGlmdCgpO1xuICAgIHBhcnNlZC50eXBlID0gcGFydHMuc2hpZnQoKTtcbiAgICBpZiAocGFyc2VkLnR5cGUgPT09ICd0cnItaW50Jykge1xuICAgICAgICBwYXJzZWQudmFsdWUgPSBwYXJ0cy5zaGlmdCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHBhcnNlZC5zdWJ0eXBlID0gcGFydHMuc2hpZnQoKTtcbiAgICB9XG4gICAgcGFyc2VkLnBhcmFtZXRlcnMgPSBwYXJ0cztcbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy5jYW5kaWRhdGUgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDEyKS5zcGxpdCgnICcpO1xuXG4gICAgdmFyIGNhbmRpZGF0ZSA9IHtcbiAgICAgICAgZm91bmRhdGlvbjogcGFydHNbMF0sXG4gICAgICAgIGNvbXBvbmVudDogcGFydHNbMV0sXG4gICAgICAgIHByb3RvY29sOiBwYXJ0c1syXS50b0xvd2VyQ2FzZSgpLFxuICAgICAgICBwcmlvcml0eTogcGFydHNbM10sXG4gICAgICAgIGlwOiBwYXJ0c1s0XSxcbiAgICAgICAgcG9ydDogcGFydHNbNV0sXG4gICAgICAgIC8vIHNraXAgcGFydHNbNl0gPT0gJ3R5cCdcbiAgICAgICAgdHlwZTogcGFydHNbN11cbiAgICB9O1xuXG4gICAgZm9yICh2YXIgaSA9IDg7IGkgPCBwYXJ0cy5sZW5ndGg7IGkgKz0gMikge1xuICAgICAgICBpZiAocGFydHNbaV0gPT09ICdyYWRkcicpIHtcbiAgICAgICAgICAgIGNhbmRpZGF0ZS5yZWxBZGRyID0gcGFydHNbaSArIDFdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhcnRzW2ldID09PSAncnBvcnQnKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGUucmVsUG9ydCA9IHBhcnRzW2kgKyAxXTtcbiAgICAgICAgfSBlbHNlIGlmIChwYXJ0c1tpXSA9PT0gJ2dlbmVyYXRpb24nKSB7XG4gICAgICAgICAgICBjYW5kaWRhdGUuZ2VuZXJhdGlvbiA9IHBhcnRzW2kgKyAxXTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNhbmRpZGF0ZS5uZXR3b3JrID0gJzEnO1xuXG4gICAgcmV0dXJuIGNhbmRpZGF0ZTtcbn07XG5cbmV4cG9ydHMuc3NyYyA9IGZ1bmN0aW9uIChsaW5lcykge1xuICAgIC8vIGh0dHA6Ly90b29scy5pZXRmLm9yZy9odG1sL3JmYzU1NzZcbiAgICB2YXIgcGFyc2VkID0gW107XG4gICAgdmFyIHBlcnNzcmMgPSB7fTtcbiAgICB2YXIgcGFydHM7XG4gICAgdmFyIHNzcmM7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBwYXJ0cyA9IGxpbmVzW2ldLnN1YnN0cig3KS5zcGxpdCgnICcpO1xuICAgICAgICBzc3JjID0gcGFydHMuc2hpZnQoKTtcbiAgICAgICAgcGFydHMgPSBwYXJ0cy5qb2luKCcgJykuc3BsaXQoJzonKTtcbiAgICAgICAgdmFyIGF0dHJpYnV0ZSA9IHBhcnRzLnNoaWZ0KCk7XG4gICAgICAgIHZhciB2YWx1ZSA9IHBhcnRzLmpvaW4oJzonKSB8fCBudWxsO1xuICAgICAgICBpZiAoIXBlcnNzcmNbc3NyY10pIHBlcnNzcmNbc3NyY10gPSB7fTtcbiAgICAgICAgcGVyc3NyY1tzc3JjXVthdHRyaWJ1dGVdID0gdmFsdWU7XG4gICAgfVxuICAgIGZvciAoc3NyYyBpbiBwZXJzc3JjKSB7XG4gICAgICAgIHZhciBpdGVtID0gcGVyc3NyY1tzc3JjXTtcbiAgICAgICAgaXRlbS5zc3JjID0gc3NyYztcbiAgICAgICAgcGFyc2VkLnB1c2goaXRlbSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLmdyb3VwaW5nID0gZnVuY3Rpb24gKGxpbmVzKSB7XG4gICAgLy8gaHR0cDovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjNTg4OFxuICAgIHZhciBwYXJzZWQgPSBbXTtcbiAgICB2YXIgcGFydHM7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBwYXJ0cyA9IGxpbmVzW2ldLnN1YnN0cig4KS5zcGxpdCgnICcpO1xuICAgICAgICBwYXJzZWQucHVzaCh7XG4gICAgICAgICAgICBzZW1hbnRpY3M6IHBhcnRzLnNoaWZ0KCksXG4gICAgICAgICAgICBjb250ZW50czogcGFydHNcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuIiwidmFyIHBhcnNlcnMgPSByZXF1aXJlKCcuL3BhcnNlcnMnKTtcbnZhciBpZENvdW50ZXIgPSBNYXRoLnJhbmRvbSgpO1xuXG5cbmV4cG9ydHMudG9TZXNzaW9uSlNPTiA9IGZ1bmN0aW9uIChzZHAsIGNyZWF0b3IpIHtcbiAgICAvLyBEaXZpZGUgdGhlIFNEUCBpbnRvIHNlc3Npb24gYW5kIG1lZGlhIHNlY3Rpb25zLlxuICAgIHZhciBtZWRpYSA9IHNkcC5zcGxpdCgnXFxyXFxubT0nKTtcbiAgICBmb3IgKHZhciBpID0gMTsgaSA8IG1lZGlhLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIG1lZGlhW2ldID0gJ209JyArIG1lZGlhW2ldO1xuICAgICAgICBpZiAoaSAhPT0gbWVkaWEubGVuZ3RoIC0gMSkge1xuICAgICAgICAgICAgbWVkaWFbaV0gKz0gJ1xcclxcbic7XG4gICAgICAgIH1cbiAgICB9XG4gICAgdmFyIHNlc3Npb24gPSBtZWRpYS5zaGlmdCgpICsgJ1xcclxcbic7XG4gICAgdmFyIHNlc3Npb25MaW5lcyA9IHBhcnNlcnMubGluZXMoc2Vzc2lvbik7XG4gICAgdmFyIHBhcnNlZCA9IHt9O1xuXG4gICAgdmFyIGNvbnRlbnRzID0gW107XG4gICAgbWVkaWEuZm9yRWFjaChmdW5jdGlvbiAobSkge1xuICAgICAgICBjb250ZW50cy5wdXNoKGV4cG9ydHMudG9NZWRpYUpTT04obSwgc2Vzc2lvbiwgY3JlYXRvcikpO1xuICAgIH0pO1xuICAgIHBhcnNlZC5jb250ZW50cyA9IGNvbnRlbnRzO1xuXG4gICAgdmFyIGdyb3VwTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1ncm91cDonLCBzZXNzaW9uTGluZXMpO1xuICAgIGlmIChncm91cExpbmVzLmxlbmd0aCkge1xuICAgICAgICBwYXJzZWQuZ3JvdXBpbmdzID0gcGFyc2Vycy5ncm91cGluZyhncm91cExpbmVzKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcGFyc2VkO1xufTtcblxuZXhwb3J0cy50b01lZGlhSlNPTiA9IGZ1bmN0aW9uIChtZWRpYSwgc2Vzc2lvbiwgY3JlYXRvcikge1xuICAgIHZhciBsaW5lcyA9IHBhcnNlcnMubGluZXMobWVkaWEpO1xuICAgIHZhciBzZXNzaW9uTGluZXMgPSBwYXJzZXJzLmxpbmVzKHNlc3Npb24pO1xuICAgIHZhciBtbGluZSA9IHBhcnNlcnMubWxpbmUobGluZXNbMF0pO1xuXG4gICAgdmFyIGNvbnRlbnQgPSB7XG4gICAgICAgIGNyZWF0b3I6IGNyZWF0b3IsXG4gICAgICAgIG5hbWU6IG1saW5lLm1lZGlhLFxuICAgICAgICBkZXNjcmlwdGlvbjoge1xuICAgICAgICAgICAgZGVzY1R5cGU6ICdydHAnLFxuICAgICAgICAgICAgbWVkaWE6IG1saW5lLm1lZGlhLFxuICAgICAgICAgICAgcGF5bG9hZHM6IFtdLFxuICAgICAgICAgICAgZW5jcnlwdGlvbjogW10sXG4gICAgICAgICAgICBmZWVkYmFjazogW10sXG4gICAgICAgICAgICBoZWFkZXJFeHRlbnNpb25zOiBbXVxuICAgICAgICB9LFxuICAgICAgICB0cmFuc3BvcnQ6IHtcbiAgICAgICAgICAgIHRyYW5zVHlwZTogJ2ljZVVkcCcsXG4gICAgICAgICAgICBjYW5kaWRhdGVzOiBbXSxcbiAgICAgICAgICAgIGZpbmdlcnByaW50czogW11cbiAgICAgICAgfVxuICAgIH07XG4gICAgdmFyIGRlc2MgPSBjb250ZW50LmRlc2NyaXB0aW9uO1xuICAgIHZhciB0cmFucyA9IGNvbnRlbnQudHJhbnNwb3J0O1xuXG4gICAgdmFyIHNzcmMgPSBwYXJzZXJzLmZpbmRMaW5lKCdhPXNzcmM6JywgbGluZXMpO1xuICAgIGlmIChzc3JjKSB7XG4gICAgICAgIGRlc2Muc3NyYyA9IHNzcmMuc3Vic3RyKDcpLnNwbGl0KCcgJylbMF07XG4gICAgfVxuXG4gICAgLy8gSWYgd2UgaGF2ZSBhIG1pZCwgdXNlIHRoYXQgZm9yIHRoZSBjb250ZW50IG5hbWUgaW5zdGVhZC5cbiAgICB2YXIgbWlkID0gcGFyc2Vycy5maW5kTGluZSgnYT1taWQ6JywgbGluZXMpO1xuICAgIGlmIChtaWQpIHtcbiAgICAgICAgY29udGVudC5uYW1lID0gbWlkLnN1YnN0cig2KTtcbiAgICB9XG5cbiAgICBpZiAocGFyc2Vycy5maW5kTGluZSgnYT1zZW5kcmVjdicsIGxpbmVzLCBzZXNzaW9uTGluZXMpKSB7XG4gICAgICAgIGNvbnRlbnQuc2VuZGVycyA9ICdib3RoJztcbiAgICB9IGVsc2UgaWYgKHBhcnNlcnMuZmluZExpbmUoJ2E9c2VuZG9ubHknLCBsaW5lcywgc2Vzc2lvbkxpbmVzKSkge1xuICAgICAgICBjb250ZW50LnNlbmRlcnMgPSAnaW5pdGlhdG9yJztcbiAgICB9IGVsc2UgaWYgKHBhcnNlcnMuZmluZExpbmUoJ2E9cmVjdm9ubHknLCBsaW5lcywgc2Vzc2lvbkxpbmVzKSkge1xuICAgICAgICBjb250ZW50LnNlbmRlcnMgPSAncmVzcG9uZGVyJztcbiAgICB9IGVsc2UgaWYgKHBhcnNlcnMuZmluZExpbmUoJ2E9aW5hY3RpdmUnLCBsaW5lcywgc2Vzc2lvbkxpbmVzKSkge1xuICAgICAgICBjb250ZW50LnNlbmRlcnMgPSAnbm9uZSc7XG4gICAgfVxuXG4gICAgdmFyIHJ0cG1hcExpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9cnRwbWFwOicsIGxpbmVzKTtcbiAgICBydHBtYXBMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIHZhciBwYXlsb2FkID0gcGFyc2Vycy5ydHBtYXAobGluZSk7XG4gICAgICAgIHBheWxvYWQuZmVlZGJhY2sgPSBbXTtcblxuICAgICAgICB2YXIgZm10cExpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9Zm10cDonICsgcGF5bG9hZC5pZCwgbGluZXMpO1xuICAgICAgICBmbXRwTGluZXMuZm9yRWFjaChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgcGF5bG9hZC5wYXJhbWV0ZXJzID0gcGFyc2Vycy5mbXRwKGxpbmUpO1xuICAgICAgICB9KTtcblxuICAgICAgICB2YXIgZmJMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPXJ0Y3AtZmI6JyArIHBheWxvYWQuaWQsIGxpbmVzKTtcbiAgICAgICAgZmJMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICBwYXlsb2FkLmZlZWRiYWNrLnB1c2gocGFyc2Vycy5ydGNwZmIobGluZSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICBkZXNjLnBheWxvYWRzLnB1c2gocGF5bG9hZCk7XG4gICAgfSk7XG5cbiAgICB2YXIgY3J5cHRvTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1jcnlwdG86JywgbGluZXMsIHNlc3Npb25MaW5lcyk7XG4gICAgY3J5cHRvTGluZXMuZm9yRWFjaChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICBkZXNjLmVuY3J5cHRpb24ucHVzaChwYXJzZXJzLmNyeXB0byhsaW5lKSk7XG4gICAgfSk7XG5cbiAgICBpZiAocGFyc2Vycy5maW5kTGluZSgnYT1ydGNwLW11eCcsIGxpbmVzKSkge1xuICAgICAgICBkZXNjLm11eCA9IHRydWU7XG4gICAgfVxuXG4gICAgdmFyIGZiTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1ydGNwLWZiOionLCBsaW5lcyk7XG4gICAgZmJMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIGRlc2MuZmVlZGJhY2sucHVzaChwYXJzZXJzLnJ0Y3BmYihsaW5lKSk7XG4gICAgfSk7XG5cbiAgICB2YXIgZXh0TGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1leHRtYXA6JywgbGluZXMpO1xuICAgIGV4dExpbmVzLmZvckVhY2goZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgdmFyIGV4dCA9IHBhcnNlcnMuZXh0bWFwKGxpbmUpO1xuXG4gICAgICAgIHZhciBzZW5kZXJzID0ge1xuICAgICAgICAgICAgc2VuZG9ubHk6ICdyZXNwb25kZXInLFxuICAgICAgICAgICAgcmVjdm9ubHk6ICdpbml0aWF0b3InLFxuICAgICAgICAgICAgc2VuZHJlY3Y6ICdib3RoJyxcbiAgICAgICAgICAgIGluYWN0aXZlOiAnbm9uZSdcbiAgICAgICAgfTtcbiAgICAgICAgZXh0LnNlbmRlcnMgPSBzZW5kZXJzW2V4dC5zZW5kZXJzXTtcblxuICAgICAgICBkZXNjLmhlYWRlckV4dGVuc2lvbnMucHVzaChleHQpO1xuICAgIH0pO1xuXG4gICAgdmFyIHNzcmNMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPXNzcmM6JywgbGluZXMpO1xuICAgIGlmIChzc3JjTGluZXMubGVuZ3RoKSB7XG4gICAgICAgIGRlc2Muc3NyY3MgPSBwYXJzZXJzLnNzcmMoc3NyY0xpbmVzKTtcbiAgICB9XG5cbiAgICB2YXIgZmluZ2VycHJpbnRMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPWZpbmdlcnByaW50OicsIGxpbmVzLCBzZXNzaW9uTGluZXMpO1xuICAgIGZpbmdlcnByaW50TGluZXMuZm9yRWFjaChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICB0cmFucy5maW5nZXJwcmludHMucHVzaChwYXJzZXJzLmZpbmdlcnByaW50KGxpbmUpKTtcbiAgICB9KTtcblxuICAgIHZhciB1ZnJhZ0xpbmUgPSBwYXJzZXJzLmZpbmRMaW5lKCdhPWljZS11ZnJhZzonLCBsaW5lcywgc2Vzc2lvbkxpbmVzKTtcbiAgICB2YXIgcHdkTGluZSA9IHBhcnNlcnMuZmluZExpbmUoJ2E9aWNlLXB3ZDonLCBsaW5lcywgc2Vzc2lvbkxpbmVzKTtcbiAgICBpZiAodWZyYWdMaW5lICYmIHB3ZExpbmUpIHtcbiAgICAgICAgdHJhbnMudWZyYWcgPSB1ZnJhZ0xpbmUuc3Vic3RyKDEyKTtcbiAgICAgICAgdHJhbnMucHdkID0gcHdkTGluZS5zdWJzdHIoMTApO1xuICAgICAgICB0cmFucy5jYW5kaWRhdGVzID0gW107XG5cbiAgICAgICAgdmFyIGNhbmRpZGF0ZUxpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9Y2FuZGlkYXRlOicsIGxpbmVzLCBzZXNzaW9uTGluZXMpO1xuICAgICAgICBjYW5kaWRhdGVMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICB0cmFucy5jYW5kaWRhdGVzLnB1c2goZXhwb3J0cy50b0NhbmRpZGF0ZUpTT04obGluZSkpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gY29udGVudDtcbn07XG5cbmV4cG9ydHMudG9DYW5kaWRhdGVKU09OID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgICB2YXIgY2FuZGlkYXRlID0gcGFyc2Vycy5jYW5kaWRhdGUobGluZS5zcGxpdCgnXFxyXFxuJylbMF0pO1xuICAgIGNhbmRpZGF0ZS5pZCA9IChpZENvdW50ZXIrKykudG9TdHJpbmcoMzYpLnN1YnN0cigwLCAxMik7XG4gICAgcmV0dXJuIGNhbmRpZGF0ZTtcbn07XG4iLCJ2YXIgc2VuZGVycyA9IHtcbiAgICAnaW5pdGlhdG9yJzogJ3NlbmRvbmx5JyxcbiAgICAncmVzcG9uZGVyJzogJ3JlY3Zvbmx5JyxcbiAgICAnYm90aCc6ICdzZW5kcmVjdicsXG4gICAgJ25vbmUnOiAnaW5hY3RpdmUnLFxuICAgICdzZW5kb25seSc6ICdpbml0YXRvcicsXG4gICAgJ3JlY3Zvbmx5JzogJ3Jlc3BvbmRlcicsXG4gICAgJ3NlbmRyZWN2JzogJ2JvdGgnLFxuICAgICdpbmFjdGl2ZSc6ICdub25lJ1xufTtcblxuXG5leHBvcnRzLnRvU2Vzc2lvblNEUCA9IGZ1bmN0aW9uIChzZXNzaW9uLCBzaWQpIHtcbiAgICB2YXIgc2RwID0gW1xuICAgICAgICAndj0wJyxcbiAgICAgICAgJ289LSAnICsgKHNpZCB8fCBzZXNzaW9uLnNpZCB8fCBEYXRlLm5vdygpKSArICcgJyArIERhdGUubm93KCkgKyAnIElOIElQNCAwLjAuMC4wJyxcbiAgICAgICAgJ3M9LScsXG4gICAgICAgICd0PTAgMCdcbiAgICBdO1xuXG4gICAgdmFyIGdyb3VwaW5ncyA9IHNlc3Npb24uZ3JvdXBpbmdzIHx8IFtdO1xuICAgIGdyb3VwaW5ncy5mb3JFYWNoKGZ1bmN0aW9uIChncm91cGluZykge1xuICAgICAgICBzZHAucHVzaCgnYT1ncm91cDonICsgZ3JvdXBpbmcuc2VtYW50aWNzICsgJyAnICsgZ3JvdXBpbmcuY29udGVudHMuam9pbignICcpKTtcbiAgICB9KTtcblxuICAgIHZhciBjb250ZW50cyA9IHNlc3Npb24uY29udGVudHMgfHwgW107XG4gICAgY29udGVudHMuZm9yRWFjaChmdW5jdGlvbiAoY29udGVudCkge1xuICAgICAgICBzZHAucHVzaChleHBvcnRzLnRvTWVkaWFTRFAoY29udGVudCkpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHNkcC5qb2luKCdcXHJcXG4nKSArICdcXHJcXG4nO1xufTtcblxuZXhwb3J0cy50b01lZGlhU0RQID0gZnVuY3Rpb24gKGNvbnRlbnQpIHtcbiAgICB2YXIgc2RwID0gW107XG5cbiAgICB2YXIgZGVzYyA9IGNvbnRlbnQuZGVzY3JpcHRpb247XG4gICAgdmFyIHRyYW5zcG9ydCA9IGNvbnRlbnQudHJhbnNwb3J0O1xuICAgIHZhciBwYXlsb2FkcyA9IGRlc2MucGF5bG9hZHMgfHwgW107XG4gICAgdmFyIGZpbmdlcnByaW50cyA9ICh0cmFuc3BvcnQgJiYgdHJhbnNwb3J0LmZpbmdlcnByaW50cykgfHwgW107XG5cbiAgICB2YXIgbWxpbmUgPSBbZGVzYy5tZWRpYSwgJzEnXTtcblxuICAgIGlmICgoZGVzYy5lbmNyeXB0aW9uICYmIGRlc2MuZW5jcnlwdGlvbi5sZW5ndGggPiAwKSB8fCAoZmluZ2VycHJpbnRzLmxlbmd0aCA+IDApKSB7XG4gICAgICAgIG1saW5lLnB1c2goJ1JUUC9TQVZQRicpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG1saW5lLnB1c2goJ1JUUC9BVlBGJyk7XG4gICAgfVxuICAgIHBheWxvYWRzLmZvckVhY2goZnVuY3Rpb24gKHBheWxvYWQpIHtcbiAgICAgICAgbWxpbmUucHVzaChwYXlsb2FkLmlkKTtcbiAgICB9KTtcblxuXG4gICAgc2RwLnB1c2goJ209JyArIG1saW5lLmpvaW4oJyAnKSk7XG5cbiAgICBzZHAucHVzaCgnYz1JTiBJUDQgMC4wLjAuMCcpO1xuICAgIHNkcC5wdXNoKCdhPXJ0Y3A6MSBJTiBJUDQgMC4wLjAuMCcpO1xuXG4gICAgaWYgKHRyYW5zcG9ydCkge1xuICAgICAgICBpZiAodHJhbnNwb3J0LnVmcmFnKSB7XG4gICAgICAgICAgICBzZHAucHVzaCgnYT1pY2UtdWZyYWc6JyArIHRyYW5zcG9ydC51ZnJhZyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRyYW5zcG9ydC5wd2QpIHtcbiAgICAgICAgICAgIHNkcC5wdXNoKCdhPWljZS1wd2Q6JyArIHRyYW5zcG9ydC5wd2QpO1xuICAgICAgICB9XG4gICAgICAgIGZpbmdlcnByaW50cy5mb3JFYWNoKGZ1bmN0aW9uIChmaW5nZXJwcmludCkge1xuICAgICAgICAgICAgc2RwLnB1c2goJ2E9ZmluZ2VycHJpbnQ6JyArIGZpbmdlcnByaW50Lmhhc2ggKyAnICcgKyBmaW5nZXJwcmludC52YWx1ZSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHNkcC5wdXNoKCdhPScgKyAoc2VuZGVyc1tjb250ZW50LnNlbmRlcnNdIHx8ICdzZW5kcmVjdicpKTtcbiAgICBzZHAucHVzaCgnYT1taWQ6JyArIGNvbnRlbnQubmFtZSk7XG5cbiAgICBpZiAoZGVzYy5tdXgpIHtcbiAgICAgICAgc2RwLnB1c2goJ2E9cnRjcC1tdXgnKTtcbiAgICB9XG5cbiAgICB2YXIgZW5jcnlwdGlvbiA9IGRlc2MuZW5jcnlwdGlvbiB8fCBbXTtcbiAgICBlbmNyeXB0aW9uLmZvckVhY2goZnVuY3Rpb24gKGNyeXB0bykge1xuICAgICAgICBzZHAucHVzaCgnYT1jcnlwdG86JyArIGNyeXB0by50YWcgKyAnICcgKyBjcnlwdG8uY2lwaGVyU3VpdGUgKyAnICcgKyBjcnlwdG8ua2V5UGFyYW1zICsgKGNyeXB0by5zZXNzaW9uUGFyYW1zID8gJyAnICsgY3J5cHRvLnNlc3Npb25QYXJhbXMgOiAnJykpO1xuICAgIH0pO1xuXG4gICAgcGF5bG9hZHMuZm9yRWFjaChmdW5jdGlvbiAocGF5bG9hZCkge1xuICAgICAgICB2YXIgcnRwbWFwID0gJ2E9cnRwbWFwOicgKyBwYXlsb2FkLmlkICsgJyAnICsgcGF5bG9hZC5uYW1lICsgJy8nICsgcGF5bG9hZC5jbG9ja3JhdGU7XG4gICAgICAgIGlmIChwYXlsb2FkLmNoYW5uZWxzICYmIHBheWxvYWQuY2hhbm5lbHMgIT0gJzEnKSB7XG4gICAgICAgICAgICBydHBtYXAgKz0gJy8nICsgcGF5bG9hZC5jaGFubmVscztcbiAgICAgICAgfVxuICAgICAgICBzZHAucHVzaChydHBtYXApO1xuXG4gICAgICAgIGlmIChwYXlsb2FkLnBhcmFtZXRlcnMgJiYgcGF5bG9hZC5wYXJhbWV0ZXJzLmxlbmd0aCkge1xuICAgICAgICAgICAgdmFyIGZtdHAgPSBbJ2E9Zm10cDonICsgcGF5bG9hZC5pZF07XG4gICAgICAgICAgICBwYXlsb2FkLnBhcmFtZXRlcnMuZm9yRWFjaChmdW5jdGlvbiAocGFyYW0pIHtcbiAgICAgICAgICAgICAgICBmbXRwLnB1c2goKHBhcmFtLmtleSA/IHBhcmFtLmtleSArICc9JyA6ICcnKSArIHBhcmFtLnZhbHVlKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2RwLnB1c2goZm10cC5qb2luKCcgJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBheWxvYWQuZmVlZGJhY2spIHtcbiAgICAgICAgICAgIHBheWxvYWQuZmVlZGJhY2suZm9yRWFjaChmdW5jdGlvbiAoZmIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmIudHlwZSA9PT0gJ3Ryci1pbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNkcC5wdXNoKCdhPXJ0Y3AtZmI6JyArIHBheWxvYWQuaWQgKyAnIHRyci1pbnQgJyArIGZiLnZhbHVlID8gZmIudmFsdWUgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNkcC5wdXNoKCdhPXJ0Y3AtZmI6JyArIHBheWxvYWQuaWQgKyAnICcgKyBmYi50eXBlICsgKGZiLnN1YnR5cGUgPyAnICcgKyBmYi5zdWJ0eXBlIDogJycpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGRlc2MuZmVlZGJhY2spIHtcbiAgICAgICAgZGVzYy5mZWVkYmFjay5mb3JFYWNoKGZ1bmN0aW9uIChmYikge1xuICAgICAgICAgICAgaWYgKGZiLnR5cGUgPT09ICd0cnItaW50Jykge1xuICAgICAgICAgICAgICAgIHNkcC5wdXNoKCdhPXJ0Y3AtZmI6KiB0cnItaW50ICcgKyBmYi52YWx1ZSA/IGZiLnZhbHVlIDogJzAnKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2RwLnB1c2goJ2E9cnRjcC1mYjoqICcgKyBmYi50eXBlICsgKGZiLnN1YnR5cGUgPyAnICcgKyBmYi5zdWJ0eXBlIDogJycpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdmFyIGhkckV4dHMgPSBkZXNjLmhlYWRlckV4dGVuc2lvbnMgfHwgW107XG4gICAgaGRyRXh0cy5mb3JFYWNoKGZ1bmN0aW9uIChoZHIpIHtcbiAgICAgICAgc2RwLnB1c2goJ2E9ZXh0bWFwOicgKyBoZHIuaWQgKyAoaGRyLnNlbmRlcnMgPyAnLycgKyBzZW5kZXJzW2hkci5zZW5kZXJzXSA6ICcnKSArICcgJyArIGhkci51cmkpO1xuICAgIH0pO1xuXG4gICAgdmFyIHNzcmNzID0gZGVzYy5zc3JjcyB8fCBbXTtcbiAgICBzc3Jjcy5mb3JFYWNoKGZ1bmN0aW9uIChzc3JjKSB7XG4gICAgICAgIGZvciAodmFyIGF0dHJpYnV0ZSBpbiBzc3JjKSB7XG4gICAgICAgICAgICBpZiAoYXR0cmlidXRlID09ICdzc3JjJykgY29udGludWU7XG4gICAgICAgICAgICBzZHAucHVzaCgnYT1zc3JjOicgKyAoc3NyYy5zc3JjIHx8IGRlc2Muc3NyYykgKyAnICcgKyBhdHRyaWJ1dGUgKyAoc3NyY1thdHRyaWJ1dGVdID8gKCc6JyArIHNzcmNbYXR0cmlidXRlXSkgOiAnJykpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICB2YXIgY2FuZGlkYXRlcyA9IHRyYW5zcG9ydC5jYW5kaWRhdGVzIHx8IFtdO1xuICAgIGNhbmRpZGF0ZXMuZm9yRWFjaChmdW5jdGlvbiAoY2FuZGlkYXRlKSB7XG4gICAgICAgIHNkcC5wdXNoKGV4cG9ydHMudG9DYW5kaWRhdGVTRFAoY2FuZGlkYXRlKSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gc2RwLmpvaW4oJ1xcclxcbicpO1xufTtcblxuZXhwb3J0cy50b0NhbmRpZGF0ZVNEUCA9IGZ1bmN0aW9uIChjYW5kaWRhdGUpIHtcbiAgICB2YXIgc2RwID0gW107XG5cbiAgICBzZHAucHVzaChjYW5kaWRhdGUuZm91bmRhdGlvbik7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLmNvbXBvbmVudCk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLnByb3RvY29sKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUucHJpb3JpdHkpO1xuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5pcCk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLnBvcnQpO1xuXG4gICAgdmFyIHR5cGUgPSBjYW5kaWRhdGUudHlwZTtcbiAgICBzZHAucHVzaCgndHlwJyk7XG4gICAgc2RwLnB1c2godHlwZSk7XG4gICAgaWYgKHR5cGUgPT09ICdzcmZseCcgfHwgdHlwZSA9PT0gJ3ByZmx4JyB8fCB0eXBlID09PSAncmVsYXknKSB7XG4gICAgICAgIGlmIChjYW5kaWRhdGUucmVsQWRkciAmJiBjYW5kaWRhdGUucmVsUG9ydCkge1xuICAgICAgICAgICAgc2RwLnB1c2goJ3JhZGRyJyk7XG4gICAgICAgICAgICBzZHAucHVzaChjYW5kaWRhdGUucmVsQWRkcik7XG4gICAgICAgICAgICBzZHAucHVzaCgncnBvcnQnKTtcbiAgICAgICAgICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5yZWxQb3J0KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNkcC5wdXNoKCdnZW5lcmF0aW9uJyk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLmdlbmVyYXRpb24gfHwgJzAnKTtcblxuICAgIHJldHVybiAnYT1jYW5kaWRhdGU6JyArIHNkcC5qb2luKCcgJyk7XG59O1xuIiwiLy8gICAgIFVuZGVyc2NvcmUuanMgMS41LjJcbi8vICAgICBodHRwOi8vdW5kZXJzY29yZWpzLm9yZ1xuLy8gICAgIChjKSAyMDA5LTIwMTMgSmVyZW15IEFzaGtlbmFzLCBEb2N1bWVudENsb3VkIGFuZCBJbnZlc3RpZ2F0aXZlIFJlcG9ydGVycyAmIEVkaXRvcnNcbi8vICAgICBVbmRlcnNjb3JlIG1heSBiZSBmcmVlbHkgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlLlxuXG4oZnVuY3Rpb24oKSB7XG5cbiAgLy8gQmFzZWxpbmUgc2V0dXBcbiAgLy8gLS0tLS0tLS0tLS0tLS1cblxuICAvLyBFc3RhYmxpc2ggdGhlIHJvb3Qgb2JqZWN0LCBgd2luZG93YCBpbiB0aGUgYnJvd3Nlciwgb3IgYGV4cG9ydHNgIG9uIHRoZSBzZXJ2ZXIuXG4gIHZhciByb290ID0gdGhpcztcblxuICAvLyBTYXZlIHRoZSBwcmV2aW91cyB2YWx1ZSBvZiB0aGUgYF9gIHZhcmlhYmxlLlxuICB2YXIgcHJldmlvdXNVbmRlcnNjb3JlID0gcm9vdC5fO1xuXG4gIC8vIEVzdGFibGlzaCB0aGUgb2JqZWN0IHRoYXQgZ2V0cyByZXR1cm5lZCB0byBicmVhayBvdXQgb2YgYSBsb29wIGl0ZXJhdGlvbi5cbiAgdmFyIGJyZWFrZXIgPSB7fTtcblxuICAvLyBTYXZlIGJ5dGVzIGluIHRoZSBtaW5pZmllZCAoYnV0IG5vdCBnemlwcGVkKSB2ZXJzaW9uOlxuICB2YXIgQXJyYXlQcm90byA9IEFycmF5LnByb3RvdHlwZSwgT2JqUHJvdG8gPSBPYmplY3QucHJvdG90eXBlLCBGdW5jUHJvdG8gPSBGdW5jdGlvbi5wcm90b3R5cGU7XG5cbiAgLy8gQ3JlYXRlIHF1aWNrIHJlZmVyZW5jZSB2YXJpYWJsZXMgZm9yIHNwZWVkIGFjY2VzcyB0byBjb3JlIHByb3RvdHlwZXMuXG4gIHZhclxuICAgIHB1c2ggICAgICAgICAgICAgPSBBcnJheVByb3RvLnB1c2gsXG4gICAgc2xpY2UgICAgICAgICAgICA9IEFycmF5UHJvdG8uc2xpY2UsXG4gICAgY29uY2F0ICAgICAgICAgICA9IEFycmF5UHJvdG8uY29uY2F0LFxuICAgIHRvU3RyaW5nICAgICAgICAgPSBPYmpQcm90by50b1N0cmluZyxcbiAgICBoYXNPd25Qcm9wZXJ0eSAgID0gT2JqUHJvdG8uaGFzT3duUHJvcGVydHk7XG5cbiAgLy8gQWxsICoqRUNNQVNjcmlwdCA1KiogbmF0aXZlIGZ1bmN0aW9uIGltcGxlbWVudGF0aW9ucyB0aGF0IHdlIGhvcGUgdG8gdXNlXG4gIC8vIGFyZSBkZWNsYXJlZCBoZXJlLlxuICB2YXJcbiAgICBuYXRpdmVGb3JFYWNoICAgICAgPSBBcnJheVByb3RvLmZvckVhY2gsXG4gICAgbmF0aXZlTWFwICAgICAgICAgID0gQXJyYXlQcm90by5tYXAsXG4gICAgbmF0aXZlUmVkdWNlICAgICAgID0gQXJyYXlQcm90by5yZWR1Y2UsXG4gICAgbmF0aXZlUmVkdWNlUmlnaHQgID0gQXJyYXlQcm90by5yZWR1Y2VSaWdodCxcbiAgICBuYXRpdmVGaWx0ZXIgICAgICAgPSBBcnJheVByb3RvLmZpbHRlcixcbiAgICBuYXRpdmVFdmVyeSAgICAgICAgPSBBcnJheVByb3RvLmV2ZXJ5LFxuICAgIG5hdGl2ZVNvbWUgICAgICAgICA9IEFycmF5UHJvdG8uc29tZSxcbiAgICBuYXRpdmVJbmRleE9mICAgICAgPSBBcnJheVByb3RvLmluZGV4T2YsXG4gICAgbmF0aXZlTGFzdEluZGV4T2YgID0gQXJyYXlQcm90by5sYXN0SW5kZXhPZixcbiAgICBuYXRpdmVJc0FycmF5ICAgICAgPSBBcnJheS5pc0FycmF5LFxuICAgIG5hdGl2ZUtleXMgICAgICAgICA9IE9iamVjdC5rZXlzLFxuICAgIG5hdGl2ZUJpbmQgICAgICAgICA9IEZ1bmNQcm90by5iaW5kO1xuXG4gIC8vIENyZWF0ZSBhIHNhZmUgcmVmZXJlbmNlIHRvIHRoZSBVbmRlcnNjb3JlIG9iamVjdCBmb3IgdXNlIGJlbG93LlxuICB2YXIgXyA9IGZ1bmN0aW9uKG9iaikge1xuICAgIGlmIChvYmogaW5zdGFuY2VvZiBfKSByZXR1cm4gb2JqO1xuICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBfKSkgcmV0dXJuIG5ldyBfKG9iaik7XG4gICAgdGhpcy5fd3JhcHBlZCA9IG9iajtcbiAgfTtcblxuICAvLyBFeHBvcnQgdGhlIFVuZGVyc2NvcmUgb2JqZWN0IGZvciAqKk5vZGUuanMqKiwgd2l0aFxuICAvLyBiYWNrd2FyZHMtY29tcGF0aWJpbGl0eSBmb3IgdGhlIG9sZCBgcmVxdWlyZSgpYCBBUEkuIElmIHdlJ3JlIGluXG4gIC8vIHRoZSBicm93c2VyLCBhZGQgYF9gIGFzIGEgZ2xvYmFsIG9iamVjdCB2aWEgYSBzdHJpbmcgaWRlbnRpZmllcixcbiAgLy8gZm9yIENsb3N1cmUgQ29tcGlsZXIgXCJhZHZhbmNlZFwiIG1vZGUuXG4gIGlmICh0eXBlb2YgZXhwb3J0cyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBpZiAodHlwZW9mIG1vZHVsZSAhPT0gJ3VuZGVmaW5lZCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgIGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cyA9IF87XG4gICAgfVxuICAgIGV4cG9ydHMuXyA9IF87XG4gIH0gZWxzZSB7XG4gICAgcm9vdC5fID0gXztcbiAgfVxuXG4gIC8vIEN1cnJlbnQgdmVyc2lvbi5cbiAgXy5WRVJTSU9OID0gJzEuNS4yJztcblxuICAvLyBDb2xsZWN0aW9uIEZ1bmN0aW9uc1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8vIFRoZSBjb3JuZXJzdG9uZSwgYW4gYGVhY2hgIGltcGxlbWVudGF0aW9uLCBha2EgYGZvckVhY2hgLlxuICAvLyBIYW5kbGVzIG9iamVjdHMgd2l0aCB0aGUgYnVpbHQtaW4gYGZvckVhY2hgLCBhcnJheXMsIGFuZCByYXcgb2JqZWN0cy5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYGZvckVhY2hgIGlmIGF2YWlsYWJsZS5cbiAgdmFyIGVhY2ggPSBfLmVhY2ggPSBfLmZvckVhY2ggPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm47XG4gICAgaWYgKG5hdGl2ZUZvckVhY2ggJiYgb2JqLmZvckVhY2ggPT09IG5hdGl2ZUZvckVhY2gpIHtcbiAgICAgIG9iai5mb3JFYWNoKGl0ZXJhdG9yLCBjb250ZXh0KTtcbiAgICB9IGVsc2UgaWYgKG9iai5sZW5ndGggPT09ICtvYmoubGVuZ3RoKSB7XG4gICAgICBmb3IgKHZhciBpID0gMCwgbGVuZ3RoID0gb2JqLmxlbmd0aDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChpdGVyYXRvci5jYWxsKGNvbnRleHQsIG9ialtpXSwgaSwgb2JqKSA9PT0gYnJlYWtlcikgcmV0dXJuO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB2YXIga2V5cyA9IF8ua2V5cyhvYmopO1xuICAgICAgZm9yICh2YXIgaSA9IDAsIGxlbmd0aCA9IGtleXMubGVuZ3RoOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgb2JqW2tleXNbaV1dLCBrZXlzW2ldLCBvYmopID09PSBicmVha2VyKSByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIC8vIFJldHVybiB0aGUgcmVzdWx0cyBvZiBhcHBseWluZyB0aGUgaXRlcmF0b3IgdG8gZWFjaCBlbGVtZW50LlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgbWFwYCBpZiBhdmFpbGFibGUuXG4gIF8ubWFwID0gXy5jb2xsZWN0ID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIHZhciByZXN1bHRzID0gW107XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gcmVzdWx0cztcbiAgICBpZiAobmF0aXZlTWFwICYmIG9iai5tYXAgPT09IG5hdGl2ZU1hcCkgcmV0dXJuIG9iai5tYXAoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIHJlc3VsdHMucHVzaChpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9O1xuXG4gIHZhciByZWR1Y2VFcnJvciA9ICdSZWR1Y2Ugb2YgZW1wdHkgYXJyYXkgd2l0aCBubyBpbml0aWFsIHZhbHVlJztcblxuICAvLyAqKlJlZHVjZSoqIGJ1aWxkcyB1cCBhIHNpbmdsZSByZXN1bHQgZnJvbSBhIGxpc3Qgb2YgdmFsdWVzLCBha2EgYGluamVjdGAsXG4gIC8vIG9yIGBmb2xkbGAuIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGByZWR1Y2VgIGlmIGF2YWlsYWJsZS5cbiAgXy5yZWR1Y2UgPSBfLmZvbGRsID0gXy5pbmplY3QgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBtZW1vLCBjb250ZXh0KSB7XG4gICAgdmFyIGluaXRpYWwgPSBhcmd1bWVudHMubGVuZ3RoID4gMjtcbiAgICBpZiAob2JqID09IG51bGwpIG9iaiA9IFtdO1xuICAgIGlmIChuYXRpdmVSZWR1Y2UgJiYgb2JqLnJlZHVjZSA9PT0gbmF0aXZlUmVkdWNlKSB7XG4gICAgICBpZiAoY29udGV4dCkgaXRlcmF0b3IgPSBfLmJpbmQoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgICAgcmV0dXJuIGluaXRpYWwgPyBvYmoucmVkdWNlKGl0ZXJhdG9yLCBtZW1vKSA6IG9iai5yZWR1Y2UoaXRlcmF0b3IpO1xuICAgIH1cbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpZiAoIWluaXRpYWwpIHtcbiAgICAgICAgbWVtbyA9IHZhbHVlO1xuICAgICAgICBpbml0aWFsID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1lbW8gPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIG1lbW8sIHZhbHVlLCBpbmRleCwgbGlzdCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgaWYgKCFpbml0aWFsKSB0aHJvdyBuZXcgVHlwZUVycm9yKHJlZHVjZUVycm9yKTtcbiAgICByZXR1cm4gbWVtbztcbiAgfTtcblxuICAvLyBUaGUgcmlnaHQtYXNzb2NpYXRpdmUgdmVyc2lvbiBvZiByZWR1Y2UsIGFsc28ga25vd24gYXMgYGZvbGRyYC5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYHJlZHVjZVJpZ2h0YCBpZiBhdmFpbGFibGUuXG4gIF8ucmVkdWNlUmlnaHQgPSBfLmZvbGRyID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgbWVtbywgY29udGV4dCkge1xuICAgIHZhciBpbml0aWFsID0gYXJndW1lbnRzLmxlbmd0aCA+IDI7XG4gICAgaWYgKG9iaiA9PSBudWxsKSBvYmogPSBbXTtcbiAgICBpZiAobmF0aXZlUmVkdWNlUmlnaHQgJiYgb2JqLnJlZHVjZVJpZ2h0ID09PSBuYXRpdmVSZWR1Y2VSaWdodCkge1xuICAgICAgaWYgKGNvbnRleHQpIGl0ZXJhdG9yID0gXy5iaW5kKGl0ZXJhdG9yLCBjb250ZXh0KTtcbiAgICAgIHJldHVybiBpbml0aWFsID8gb2JqLnJlZHVjZVJpZ2h0KGl0ZXJhdG9yLCBtZW1vKSA6IG9iai5yZWR1Y2VSaWdodChpdGVyYXRvcik7XG4gICAgfVxuICAgIHZhciBsZW5ndGggPSBvYmoubGVuZ3RoO1xuICAgIGlmIChsZW5ndGggIT09ICtsZW5ndGgpIHtcbiAgICAgIHZhciBrZXlzID0gXy5rZXlzKG9iaik7XG4gICAgICBsZW5ndGggPSBrZXlzLmxlbmd0aDtcbiAgICB9XG4gICAgZWFjaChvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCwgbGlzdCkge1xuICAgICAgaW5kZXggPSBrZXlzID8ga2V5c1stLWxlbmd0aF0gOiAtLWxlbmd0aDtcbiAgICAgIGlmICghaW5pdGlhbCkge1xuICAgICAgICBtZW1vID0gb2JqW2luZGV4XTtcbiAgICAgICAgaW5pdGlhbCA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZW1vID0gaXRlcmF0b3IuY2FsbChjb250ZXh0LCBtZW1vLCBvYmpbaW5kZXhdLCBpbmRleCwgbGlzdCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgaWYgKCFpbml0aWFsKSB0aHJvdyBuZXcgVHlwZUVycm9yKHJlZHVjZUVycm9yKTtcbiAgICByZXR1cm4gbWVtbztcbiAgfTtcblxuICAvLyBSZXR1cm4gdGhlIGZpcnN0IHZhbHVlIHdoaWNoIHBhc3NlcyBhIHRydXRoIHRlc3QuIEFsaWFzZWQgYXMgYGRldGVjdGAuXG4gIF8uZmluZCA9IF8uZGV0ZWN0ID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIHZhciByZXN1bHQ7XG4gICAgYW55KG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpZiAoaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIGxpc3QpKSB7XG4gICAgICAgIHJlc3VsdCA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xuXG4gIC8vIFJldHVybiBhbGwgdGhlIGVsZW1lbnRzIHRoYXQgcGFzcyBhIHRydXRoIHRlc3QuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBmaWx0ZXJgIGlmIGF2YWlsYWJsZS5cbiAgLy8gQWxpYXNlZCBhcyBgc2VsZWN0YC5cbiAgXy5maWx0ZXIgPSBfLnNlbGVjdCA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgIGlmIChvYmogPT0gbnVsbCkgcmV0dXJuIHJlc3VsdHM7XG4gICAgaWYgKG5hdGl2ZUZpbHRlciAmJiBvYmouZmlsdGVyID09PSBuYXRpdmVGaWx0ZXIpIHJldHVybiBvYmouZmlsdGVyKGl0ZXJhdG9yLCBjb250ZXh0KTtcbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpZiAoaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIGxpc3QpKSByZXN1bHRzLnB1c2godmFsdWUpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9O1xuXG4gIC8vIFJldHVybiBhbGwgdGhlIGVsZW1lbnRzIGZvciB3aGljaCBhIHRydXRoIHRlc3QgZmFpbHMuXG4gIF8ucmVqZWN0ID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIHJldHVybiBfLmZpbHRlcihvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCwgbGlzdCkge1xuICAgICAgcmV0dXJuICFpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCk7XG4gICAgfSwgY29udGV4dCk7XG4gIH07XG5cbiAgLy8gRGV0ZXJtaW5lIHdoZXRoZXIgYWxsIG9mIHRoZSBlbGVtZW50cyBtYXRjaCBhIHRydXRoIHRlc3QuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBldmVyeWAgaWYgYXZhaWxhYmxlLlxuICAvLyBBbGlhc2VkIGFzIGBhbGxgLlxuICBfLmV2ZXJ5ID0gXy5hbGwgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgaXRlcmF0b3IgfHwgKGl0ZXJhdG9yID0gXy5pZGVudGl0eSk7XG4gICAgdmFyIHJlc3VsdCA9IHRydWU7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gcmVzdWx0O1xuICAgIGlmIChuYXRpdmVFdmVyeSAmJiBvYmouZXZlcnkgPT09IG5hdGl2ZUV2ZXJ5KSByZXR1cm4gb2JqLmV2ZXJ5KGl0ZXJhdG9yLCBjb250ZXh0KTtcbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpZiAoIShyZXN1bHQgPSByZXN1bHQgJiYgaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIGxpc3QpKSkgcmV0dXJuIGJyZWFrZXI7XG4gICAgfSk7XG4gICAgcmV0dXJuICEhcmVzdWx0O1xuICB9O1xuXG4gIC8vIERldGVybWluZSBpZiBhdCBsZWFzdCBvbmUgZWxlbWVudCBpbiB0aGUgb2JqZWN0IG1hdGNoZXMgYSB0cnV0aCB0ZXN0LlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgc29tZWAgaWYgYXZhaWxhYmxlLlxuICAvLyBBbGlhc2VkIGFzIGBhbnlgLlxuICB2YXIgYW55ID0gXy5zb21lID0gXy5hbnkgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgaXRlcmF0b3IgfHwgKGl0ZXJhdG9yID0gXy5pZGVudGl0eSk7XG4gICAgdmFyIHJlc3VsdCA9IGZhbHNlO1xuICAgIGlmIChvYmogPT0gbnVsbCkgcmV0dXJuIHJlc3VsdDtcbiAgICBpZiAobmF0aXZlU29tZSAmJiBvYmouc29tZSA9PT0gbmF0aXZlU29tZSkgcmV0dXJuIG9iai5zb21lKGl0ZXJhdG9yLCBjb250ZXh0KTtcbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpZiAocmVzdWx0IHx8IChyZXN1bHQgPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkpKSByZXR1cm4gYnJlYWtlcjtcbiAgICB9KTtcbiAgICByZXR1cm4gISFyZXN1bHQ7XG4gIH07XG5cbiAgLy8gRGV0ZXJtaW5lIGlmIHRoZSBhcnJheSBvciBvYmplY3QgY29udGFpbnMgYSBnaXZlbiB2YWx1ZSAodXNpbmcgYD09PWApLlxuICAvLyBBbGlhc2VkIGFzIGBpbmNsdWRlYC5cbiAgXy5jb250YWlucyA9IF8uaW5jbHVkZSA9IGZ1bmN0aW9uKG9iaiwgdGFyZ2V0KSB7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG5hdGl2ZUluZGV4T2YgJiYgb2JqLmluZGV4T2YgPT09IG5hdGl2ZUluZGV4T2YpIHJldHVybiBvYmouaW5kZXhPZih0YXJnZXQpICE9IC0xO1xuICAgIHJldHVybiBhbnkob2JqLCBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgcmV0dXJuIHZhbHVlID09PSB0YXJnZXQ7XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gSW52b2tlIGEgbWV0aG9kICh3aXRoIGFyZ3VtZW50cykgb24gZXZlcnkgaXRlbSBpbiBhIGNvbGxlY3Rpb24uXG4gIF8uaW52b2tlID0gZnVuY3Rpb24ob2JqLCBtZXRob2QpIHtcbiAgICB2YXIgYXJncyA9IHNsaWNlLmNhbGwoYXJndW1lbnRzLCAyKTtcbiAgICB2YXIgaXNGdW5jID0gXy5pc0Z1bmN0aW9uKG1ldGhvZCk7XG4gICAgcmV0dXJuIF8ubWFwKG9iaiwgZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgIHJldHVybiAoaXNGdW5jID8gbWV0aG9kIDogdmFsdWVbbWV0aG9kXSkuYXBwbHkodmFsdWUsIGFyZ3MpO1xuICAgIH0pO1xuICB9O1xuXG4gIC8vIENvbnZlbmllbmNlIHZlcnNpb24gb2YgYSBjb21tb24gdXNlIGNhc2Ugb2YgYG1hcGA6IGZldGNoaW5nIGEgcHJvcGVydHkuXG4gIF8ucGx1Y2sgPSBmdW5jdGlvbihvYmosIGtleSkge1xuICAgIHJldHVybiBfLm1hcChvYmosIGZ1bmN0aW9uKHZhbHVlKXsgcmV0dXJuIHZhbHVlW2tleV07IH0pO1xuICB9O1xuXG4gIC8vIENvbnZlbmllbmNlIHZlcnNpb24gb2YgYSBjb21tb24gdXNlIGNhc2Ugb2YgYGZpbHRlcmA6IHNlbGVjdGluZyBvbmx5IG9iamVjdHNcbiAgLy8gY29udGFpbmluZyBzcGVjaWZpYyBga2V5OnZhbHVlYCBwYWlycy5cbiAgXy53aGVyZSA9IGZ1bmN0aW9uKG9iaiwgYXR0cnMsIGZpcnN0KSB7XG4gICAgaWYgKF8uaXNFbXB0eShhdHRycykpIHJldHVybiBmaXJzdCA/IHZvaWQgMCA6IFtdO1xuICAgIHJldHVybiBfW2ZpcnN0ID8gJ2ZpbmQnIDogJ2ZpbHRlciddKG9iaiwgZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgIGZvciAodmFyIGtleSBpbiBhdHRycykge1xuICAgICAgICBpZiAoYXR0cnNba2V5XSAhPT0gdmFsdWVba2V5XSkgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gQ29udmVuaWVuY2UgdmVyc2lvbiBvZiBhIGNvbW1vbiB1c2UgY2FzZSBvZiBgZmluZGA6IGdldHRpbmcgdGhlIGZpcnN0IG9iamVjdFxuICAvLyBjb250YWluaW5nIHNwZWNpZmljIGBrZXk6dmFsdWVgIHBhaXJzLlxuICBfLmZpbmRXaGVyZSA9IGZ1bmN0aW9uKG9iaiwgYXR0cnMpIHtcbiAgICByZXR1cm4gXy53aGVyZShvYmosIGF0dHJzLCB0cnVlKTtcbiAgfTtcblxuICAvLyBSZXR1cm4gdGhlIG1heGltdW0gZWxlbWVudCBvciAoZWxlbWVudC1iYXNlZCBjb21wdXRhdGlvbikuXG4gIC8vIENhbid0IG9wdGltaXplIGFycmF5cyBvZiBpbnRlZ2VycyBsb25nZXIgdGhhbiA2NSw1MzUgZWxlbWVudHMuXG4gIC8vIFNlZSBbV2ViS2l0IEJ1ZyA4MDc5N10oaHR0cHM6Ly9idWdzLndlYmtpdC5vcmcvc2hvd19idWcuY2dpP2lkPTgwNzk3KVxuICBfLm1heCA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpZiAoIWl0ZXJhdG9yICYmIF8uaXNBcnJheShvYmopICYmIG9ialswXSA9PT0gK29ialswXSAmJiBvYmoubGVuZ3RoIDwgNjU1MzUpIHtcbiAgICAgIHJldHVybiBNYXRoLm1heC5hcHBseShNYXRoLCBvYmopO1xuICAgIH1cbiAgICBpZiAoIWl0ZXJhdG9yICYmIF8uaXNFbXB0eShvYmopKSByZXR1cm4gLUluZmluaXR5O1xuICAgIHZhciByZXN1bHQgPSB7Y29tcHV0ZWQgOiAtSW5maW5pdHksIHZhbHVlOiAtSW5maW5pdHl9O1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIHZhciBjb21wdXRlZCA9IGl0ZXJhdG9yID8gaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIGxpc3QpIDogdmFsdWU7XG4gICAgICBjb21wdXRlZCA+IHJlc3VsdC5jb21wdXRlZCAmJiAocmVzdWx0ID0ge3ZhbHVlIDogdmFsdWUsIGNvbXB1dGVkIDogY29tcHV0ZWR9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0LnZhbHVlO1xuICB9O1xuXG4gIC8vIFJldHVybiB0aGUgbWluaW11bSBlbGVtZW50IChvciBlbGVtZW50LWJhc2VkIGNvbXB1dGF0aW9uKS5cbiAgXy5taW4gPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgaWYgKCFpdGVyYXRvciAmJiBfLmlzQXJyYXkob2JqKSAmJiBvYmpbMF0gPT09ICtvYmpbMF0gJiYgb2JqLmxlbmd0aCA8IDY1NTM1KSB7XG4gICAgICByZXR1cm4gTWF0aC5taW4uYXBwbHkoTWF0aCwgb2JqKTtcbiAgICB9XG4gICAgaWYgKCFpdGVyYXRvciAmJiBfLmlzRW1wdHkob2JqKSkgcmV0dXJuIEluZmluaXR5O1xuICAgIHZhciByZXN1bHQgPSB7Y29tcHV0ZWQgOiBJbmZpbml0eSwgdmFsdWU6IEluZmluaXR5fTtcbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICB2YXIgY29tcHV0ZWQgPSBpdGVyYXRvciA/IGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgdmFsdWUsIGluZGV4LCBsaXN0KSA6IHZhbHVlO1xuICAgICAgY29tcHV0ZWQgPCByZXN1bHQuY29tcHV0ZWQgJiYgKHJlc3VsdCA9IHt2YWx1ZSA6IHZhbHVlLCBjb21wdXRlZCA6IGNvbXB1dGVkfSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdC52YWx1ZTtcbiAgfTtcblxuICAvLyBTaHVmZmxlIGFuIGFycmF5LCB1c2luZyB0aGUgbW9kZXJuIHZlcnNpb24gb2YgdGhlIFxuICAvLyBbRmlzaGVyLVlhdGVzIHNodWZmbGVdKGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvRmlzaGVy4oCTWWF0ZXNfc2h1ZmZsZSkuXG4gIF8uc2h1ZmZsZSA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciByYW5kO1xuICAgIHZhciBpbmRleCA9IDA7XG4gICAgdmFyIHNodWZmbGVkID0gW107XG4gICAgZWFjaChvYmosIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICByYW5kID0gXy5yYW5kb20oaW5kZXgrKyk7XG4gICAgICBzaHVmZmxlZFtpbmRleCAtIDFdID0gc2h1ZmZsZWRbcmFuZF07XG4gICAgICBzaHVmZmxlZFtyYW5kXSA9IHZhbHVlO1xuICAgIH0pO1xuICAgIHJldHVybiBzaHVmZmxlZDtcbiAgfTtcblxuICAvLyBTYW1wbGUgKipuKiogcmFuZG9tIHZhbHVlcyBmcm9tIGFuIGFycmF5LlxuICAvLyBJZiAqKm4qKiBpcyBub3Qgc3BlY2lmaWVkLCByZXR1cm5zIGEgc2luZ2xlIHJhbmRvbSBlbGVtZW50IGZyb20gdGhlIGFycmF5LlxuICAvLyBUaGUgaW50ZXJuYWwgYGd1YXJkYCBhcmd1bWVudCBhbGxvd3MgaXQgdG8gd29yayB3aXRoIGBtYXBgLlxuICBfLnNhbXBsZSA9IGZ1bmN0aW9uKG9iaiwgbiwgZ3VhcmQpIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA8IDIgfHwgZ3VhcmQpIHtcbiAgICAgIHJldHVybiBvYmpbXy5yYW5kb20ob2JqLmxlbmd0aCAtIDEpXTtcbiAgICB9XG4gICAgcmV0dXJuIF8uc2h1ZmZsZShvYmopLnNsaWNlKDAsIE1hdGgubWF4KDAsIG4pKTtcbiAgfTtcblxuICAvLyBBbiBpbnRlcm5hbCBmdW5jdGlvbiB0byBnZW5lcmF0ZSBsb29rdXAgaXRlcmF0b3JzLlxuICB2YXIgbG9va3VwSXRlcmF0b3IgPSBmdW5jdGlvbih2YWx1ZSkge1xuICAgIHJldHVybiBfLmlzRnVuY3Rpb24odmFsdWUpID8gdmFsdWUgOiBmdW5jdGlvbihvYmopeyByZXR1cm4gb2JqW3ZhbHVlXTsgfTtcbiAgfTtcblxuICAvLyBTb3J0IHRoZSBvYmplY3QncyB2YWx1ZXMgYnkgYSBjcml0ZXJpb24gcHJvZHVjZWQgYnkgYW4gaXRlcmF0b3IuXG4gIF8uc29ydEJ5ID0gZnVuY3Rpb24ob2JqLCB2YWx1ZSwgY29udGV4dCkge1xuICAgIHZhciBpdGVyYXRvciA9IGxvb2t1cEl0ZXJhdG9yKHZhbHVlKTtcbiAgICByZXR1cm4gXy5wbHVjayhfLm1hcChvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCwgbGlzdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmFsdWU6IHZhbHVlLFxuICAgICAgICBpbmRleDogaW5kZXgsXG4gICAgICAgIGNyaXRlcmlhOiBpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdClcbiAgICAgIH07XG4gICAgfSkuc29ydChmdW5jdGlvbihsZWZ0LCByaWdodCkge1xuICAgICAgdmFyIGEgPSBsZWZ0LmNyaXRlcmlhO1xuICAgICAgdmFyIGIgPSByaWdodC5jcml0ZXJpYTtcbiAgICAgIGlmIChhICE9PSBiKSB7XG4gICAgICAgIGlmIChhID4gYiB8fCBhID09PSB2b2lkIDApIHJldHVybiAxO1xuICAgICAgICBpZiAoYSA8IGIgfHwgYiA9PT0gdm9pZCAwKSByZXR1cm4gLTE7XG4gICAgICB9XG4gICAgICByZXR1cm4gbGVmdC5pbmRleCAtIHJpZ2h0LmluZGV4O1xuICAgIH0pLCAndmFsdWUnKTtcbiAgfTtcblxuICAvLyBBbiBpbnRlcm5hbCBmdW5jdGlvbiB1c2VkIGZvciBhZ2dyZWdhdGUgXCJncm91cCBieVwiIG9wZXJhdGlvbnMuXG4gIHZhciBncm91cCA9IGZ1bmN0aW9uKGJlaGF2aW9yKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKG9iaiwgdmFsdWUsIGNvbnRleHQpIHtcbiAgICAgIHZhciByZXN1bHQgPSB7fTtcbiAgICAgIHZhciBpdGVyYXRvciA9IHZhbHVlID09IG51bGwgPyBfLmlkZW50aXR5IDogbG9va3VwSXRlcmF0b3IodmFsdWUpO1xuICAgICAgZWFjaChvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCkge1xuICAgICAgICB2YXIga2V5ID0gaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIG9iaik7XG4gICAgICAgIGJlaGF2aW9yKHJlc3VsdCwga2V5LCB2YWx1ZSk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgfTtcblxuICAvLyBHcm91cHMgdGhlIG9iamVjdCdzIHZhbHVlcyBieSBhIGNyaXRlcmlvbi4gUGFzcyBlaXRoZXIgYSBzdHJpbmcgYXR0cmlidXRlXG4gIC8vIHRvIGdyb3VwIGJ5LCBvciBhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyB0aGUgY3JpdGVyaW9uLlxuICBfLmdyb3VwQnkgPSBncm91cChmdW5jdGlvbihyZXN1bHQsIGtleSwgdmFsdWUpIHtcbiAgICAoXy5oYXMocmVzdWx0LCBrZXkpID8gcmVzdWx0W2tleV0gOiAocmVzdWx0W2tleV0gPSBbXSkpLnB1c2godmFsdWUpO1xuICB9KTtcblxuICAvLyBJbmRleGVzIHRoZSBvYmplY3QncyB2YWx1ZXMgYnkgYSBjcml0ZXJpb24sIHNpbWlsYXIgdG8gYGdyb3VwQnlgLCBidXQgZm9yXG4gIC8vIHdoZW4geW91IGtub3cgdGhhdCB5b3VyIGluZGV4IHZhbHVlcyB3aWxsIGJlIHVuaXF1ZS5cbiAgXy5pbmRleEJ5ID0gZ3JvdXAoZnVuY3Rpb24ocmVzdWx0LCBrZXksIHZhbHVlKSB7XG4gICAgcmVzdWx0W2tleV0gPSB2YWx1ZTtcbiAgfSk7XG5cbiAgLy8gQ291bnRzIGluc3RhbmNlcyBvZiBhbiBvYmplY3QgdGhhdCBncm91cCBieSBhIGNlcnRhaW4gY3JpdGVyaW9uLiBQYXNzXG4gIC8vIGVpdGhlciBhIHN0cmluZyBhdHRyaWJ1dGUgdG8gY291bnQgYnksIG9yIGEgZnVuY3Rpb24gdGhhdCByZXR1cm5zIHRoZVxuICAvLyBjcml0ZXJpb24uXG4gIF8uY291bnRCeSA9IGdyb3VwKGZ1bmN0aW9uKHJlc3VsdCwga2V5KSB7XG4gICAgXy5oYXMocmVzdWx0LCBrZXkpID8gcmVzdWx0W2tleV0rKyA6IHJlc3VsdFtrZXldID0gMTtcbiAgfSk7XG5cbiAgLy8gVXNlIGEgY29tcGFyYXRvciBmdW5jdGlvbiB0byBmaWd1cmUgb3V0IHRoZSBzbWFsbGVzdCBpbmRleCBhdCB3aGljaFxuICAvLyBhbiBvYmplY3Qgc2hvdWxkIGJlIGluc2VydGVkIHNvIGFzIHRvIG1haW50YWluIG9yZGVyLiBVc2VzIGJpbmFyeSBzZWFyY2guXG4gIF8uc29ydGVkSW5kZXggPSBmdW5jdGlvbihhcnJheSwgb2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIGl0ZXJhdG9yID0gaXRlcmF0b3IgPT0gbnVsbCA/IF8uaWRlbnRpdHkgOiBsb29rdXBJdGVyYXRvcihpdGVyYXRvcik7XG4gICAgdmFyIHZhbHVlID0gaXRlcmF0b3IuY2FsbChjb250ZXh0LCBvYmopO1xuICAgIHZhciBsb3cgPSAwLCBoaWdoID0gYXJyYXkubGVuZ3RoO1xuICAgIHdoaWxlIChsb3cgPCBoaWdoKSB7XG4gICAgICB2YXIgbWlkID0gKGxvdyArIGhpZ2gpID4+PiAxO1xuICAgICAgaXRlcmF0b3IuY2FsbChjb250ZXh0LCBhcnJheVttaWRdKSA8IHZhbHVlID8gbG93ID0gbWlkICsgMSA6IGhpZ2ggPSBtaWQ7XG4gICAgfVxuICAgIHJldHVybiBsb3c7XG4gIH07XG5cbiAgLy8gU2FmZWx5IGNyZWF0ZSBhIHJlYWwsIGxpdmUgYXJyYXkgZnJvbSBhbnl0aGluZyBpdGVyYWJsZS5cbiAgXy50b0FycmF5ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgaWYgKCFvYmopIHJldHVybiBbXTtcbiAgICBpZiAoXy5pc0FycmF5KG9iaikpIHJldHVybiBzbGljZS5jYWxsKG9iaik7XG4gICAgaWYgKG9iai5sZW5ndGggPT09ICtvYmoubGVuZ3RoKSByZXR1cm4gXy5tYXAob2JqLCBfLmlkZW50aXR5KTtcbiAgICByZXR1cm4gXy52YWx1ZXMob2JqKTtcbiAgfTtcblxuICAvLyBSZXR1cm4gdGhlIG51bWJlciBvZiBlbGVtZW50cyBpbiBhbiBvYmplY3QuXG4gIF8uc2l6ZSA9IGZ1bmN0aW9uKG9iaikge1xuICAgIGlmIChvYmogPT0gbnVsbCkgcmV0dXJuIDA7XG4gICAgcmV0dXJuIChvYmoubGVuZ3RoID09PSArb2JqLmxlbmd0aCkgPyBvYmoubGVuZ3RoIDogXy5rZXlzKG9iaikubGVuZ3RoO1xuICB9O1xuXG4gIC8vIEFycmF5IEZ1bmN0aW9uc1xuICAvLyAtLS0tLS0tLS0tLS0tLS1cblxuICAvLyBHZXQgdGhlIGZpcnN0IGVsZW1lbnQgb2YgYW4gYXJyYXkuIFBhc3NpbmcgKipuKiogd2lsbCByZXR1cm4gdGhlIGZpcnN0IE5cbiAgLy8gdmFsdWVzIGluIHRoZSBhcnJheS4gQWxpYXNlZCBhcyBgaGVhZGAgYW5kIGB0YWtlYC4gVGhlICoqZ3VhcmQqKiBjaGVja1xuICAvLyBhbGxvd3MgaXQgdG8gd29yayB3aXRoIGBfLm1hcGAuXG4gIF8uZmlyc3QgPSBfLmhlYWQgPSBfLnRha2UgPSBmdW5jdGlvbihhcnJheSwgbiwgZ3VhcmQpIHtcbiAgICBpZiAoYXJyYXkgPT0gbnVsbCkgcmV0dXJuIHZvaWQgMDtcbiAgICByZXR1cm4gKG4gPT0gbnVsbCkgfHwgZ3VhcmQgPyBhcnJheVswXSA6IHNsaWNlLmNhbGwoYXJyYXksIDAsIG4pO1xuICB9O1xuXG4gIC8vIFJldHVybnMgZXZlcnl0aGluZyBidXQgdGhlIGxhc3QgZW50cnkgb2YgdGhlIGFycmF5LiBFc3BlY2lhbGx5IHVzZWZ1bCBvblxuICAvLyB0aGUgYXJndW1lbnRzIG9iamVjdC4gUGFzc2luZyAqKm4qKiB3aWxsIHJldHVybiBhbGwgdGhlIHZhbHVlcyBpblxuICAvLyB0aGUgYXJyYXksIGV4Y2x1ZGluZyB0aGUgbGFzdCBOLiBUaGUgKipndWFyZCoqIGNoZWNrIGFsbG93cyBpdCB0byB3b3JrIHdpdGhcbiAgLy8gYF8ubWFwYC5cbiAgXy5pbml0aWFsID0gZnVuY3Rpb24oYXJyYXksIG4sIGd1YXJkKSB7XG4gICAgcmV0dXJuIHNsaWNlLmNhbGwoYXJyYXksIDAsIGFycmF5Lmxlbmd0aCAtICgobiA9PSBudWxsKSB8fCBndWFyZCA/IDEgOiBuKSk7XG4gIH07XG5cbiAgLy8gR2V0IHRoZSBsYXN0IGVsZW1lbnQgb2YgYW4gYXJyYXkuIFBhc3NpbmcgKipuKiogd2lsbCByZXR1cm4gdGhlIGxhc3QgTlxuICAvLyB2YWx1ZXMgaW4gdGhlIGFycmF5LiBUaGUgKipndWFyZCoqIGNoZWNrIGFsbG93cyBpdCB0byB3b3JrIHdpdGggYF8ubWFwYC5cbiAgXy5sYXN0ID0gZnVuY3Rpb24oYXJyYXksIG4sIGd1YXJkKSB7XG4gICAgaWYgKGFycmF5ID09IG51bGwpIHJldHVybiB2b2lkIDA7XG4gICAgaWYgKChuID09IG51bGwpIHx8IGd1YXJkKSB7XG4gICAgICByZXR1cm4gYXJyYXlbYXJyYXkubGVuZ3RoIC0gMV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBzbGljZS5jYWxsKGFycmF5LCBNYXRoLm1heChhcnJheS5sZW5ndGggLSBuLCAwKSk7XG4gICAgfVxuICB9O1xuXG4gIC8vIFJldHVybnMgZXZlcnl0aGluZyBidXQgdGhlIGZpcnN0IGVudHJ5IG9mIHRoZSBhcnJheS4gQWxpYXNlZCBhcyBgdGFpbGAgYW5kIGBkcm9wYC5cbiAgLy8gRXNwZWNpYWxseSB1c2VmdWwgb24gdGhlIGFyZ3VtZW50cyBvYmplY3QuIFBhc3NpbmcgYW4gKipuKiogd2lsbCByZXR1cm5cbiAgLy8gdGhlIHJlc3QgTiB2YWx1ZXMgaW4gdGhlIGFycmF5LiBUaGUgKipndWFyZCoqXG4gIC8vIGNoZWNrIGFsbG93cyBpdCB0byB3b3JrIHdpdGggYF8ubWFwYC5cbiAgXy5yZXN0ID0gXy50YWlsID0gXy5kcm9wID0gZnVuY3Rpb24oYXJyYXksIG4sIGd1YXJkKSB7XG4gICAgcmV0dXJuIHNsaWNlLmNhbGwoYXJyYXksIChuID09IG51bGwpIHx8IGd1YXJkID8gMSA6IG4pO1xuICB9O1xuXG4gIC8vIFRyaW0gb3V0IGFsbCBmYWxzeSB2YWx1ZXMgZnJvbSBhbiBhcnJheS5cbiAgXy5jb21wYWN0ID0gZnVuY3Rpb24oYXJyYXkpIHtcbiAgICByZXR1cm4gXy5maWx0ZXIoYXJyYXksIF8uaWRlbnRpdHkpO1xuICB9O1xuXG4gIC8vIEludGVybmFsIGltcGxlbWVudGF0aW9uIG9mIGEgcmVjdXJzaXZlIGBmbGF0dGVuYCBmdW5jdGlvbi5cbiAgdmFyIGZsYXR0ZW4gPSBmdW5jdGlvbihpbnB1dCwgc2hhbGxvdywgb3V0cHV0KSB7XG4gICAgaWYgKHNoYWxsb3cgJiYgXy5ldmVyeShpbnB1dCwgXy5pc0FycmF5KSkge1xuICAgICAgcmV0dXJuIGNvbmNhdC5hcHBseShvdXRwdXQsIGlucHV0KTtcbiAgICB9XG4gICAgZWFjaChpbnB1dCwgZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgIGlmIChfLmlzQXJyYXkodmFsdWUpIHx8IF8uaXNBcmd1bWVudHModmFsdWUpKSB7XG4gICAgICAgIHNoYWxsb3cgPyBwdXNoLmFwcGx5KG91dHB1dCwgdmFsdWUpIDogZmxhdHRlbih2YWx1ZSwgc2hhbGxvdywgb3V0cHV0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dHB1dC5wdXNoKHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gb3V0cHV0O1xuICB9O1xuXG4gIC8vIEZsYXR0ZW4gb3V0IGFuIGFycmF5LCBlaXRoZXIgcmVjdXJzaXZlbHkgKGJ5IGRlZmF1bHQpLCBvciBqdXN0IG9uZSBsZXZlbC5cbiAgXy5mbGF0dGVuID0gZnVuY3Rpb24oYXJyYXksIHNoYWxsb3cpIHtcbiAgICByZXR1cm4gZmxhdHRlbihhcnJheSwgc2hhbGxvdywgW10pO1xuICB9O1xuXG4gIC8vIFJldHVybiBhIHZlcnNpb24gb2YgdGhlIGFycmF5IHRoYXQgZG9lcyBub3QgY29udGFpbiB0aGUgc3BlY2lmaWVkIHZhbHVlKHMpLlxuICBfLndpdGhvdXQgPSBmdW5jdGlvbihhcnJheSkge1xuICAgIHJldHVybiBfLmRpZmZlcmVuY2UoYXJyYXksIHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gIH07XG5cbiAgLy8gUHJvZHVjZSBhIGR1cGxpY2F0ZS1mcmVlIHZlcnNpb24gb2YgdGhlIGFycmF5LiBJZiB0aGUgYXJyYXkgaGFzIGFscmVhZHlcbiAgLy8gYmVlbiBzb3J0ZWQsIHlvdSBoYXZlIHRoZSBvcHRpb24gb2YgdXNpbmcgYSBmYXN0ZXIgYWxnb3JpdGhtLlxuICAvLyBBbGlhc2VkIGFzIGB1bmlxdWVgLlxuICBfLnVuaXEgPSBfLnVuaXF1ZSA9IGZ1bmN0aW9uKGFycmF5LCBpc1NvcnRlZCwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpZiAoXy5pc0Z1bmN0aW9uKGlzU29ydGVkKSkge1xuICAgICAgY29udGV4dCA9IGl0ZXJhdG9yO1xuICAgICAgaXRlcmF0b3IgPSBpc1NvcnRlZDtcbiAgICAgIGlzU29ydGVkID0gZmFsc2U7XG4gICAgfVxuICAgIHZhciBpbml0aWFsID0gaXRlcmF0b3IgPyBfLm1hcChhcnJheSwgaXRlcmF0b3IsIGNvbnRleHQpIDogYXJyYXk7XG4gICAgdmFyIHJlc3VsdHMgPSBbXTtcbiAgICB2YXIgc2VlbiA9IFtdO1xuICAgIGVhY2goaW5pdGlhbCwgZnVuY3Rpb24odmFsdWUsIGluZGV4KSB7XG4gICAgICBpZiAoaXNTb3J0ZWQgPyAoIWluZGV4IHx8IHNlZW5bc2Vlbi5sZW5ndGggLSAxXSAhPT0gdmFsdWUpIDogIV8uY29udGFpbnMoc2VlbiwgdmFsdWUpKSB7XG4gICAgICAgIHNlZW4ucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJlc3VsdHMucHVzaChhcnJheVtpbmRleF0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9O1xuXG4gIC8vIFByb2R1Y2UgYW4gYXJyYXkgdGhhdCBjb250YWlucyB0aGUgdW5pb246IGVhY2ggZGlzdGluY3QgZWxlbWVudCBmcm9tIGFsbCBvZlxuICAvLyB0aGUgcGFzc2VkLWluIGFycmF5cy5cbiAgXy51bmlvbiA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBfLnVuaXEoXy5mbGF0dGVuKGFyZ3VtZW50cywgdHJ1ZSkpO1xuICB9O1xuXG4gIC8vIFByb2R1Y2UgYW4gYXJyYXkgdGhhdCBjb250YWlucyBldmVyeSBpdGVtIHNoYXJlZCBiZXR3ZWVuIGFsbCB0aGVcbiAgLy8gcGFzc2VkLWluIGFycmF5cy5cbiAgXy5pbnRlcnNlY3Rpb24gPSBmdW5jdGlvbihhcnJheSkge1xuICAgIHZhciByZXN0ID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgIHJldHVybiBfLmZpbHRlcihfLnVuaXEoYXJyYXkpLCBmdW5jdGlvbihpdGVtKSB7XG4gICAgICByZXR1cm4gXy5ldmVyeShyZXN0LCBmdW5jdGlvbihvdGhlcikge1xuICAgICAgICByZXR1cm4gXy5pbmRleE9mKG90aGVyLCBpdGVtKSA+PSAwO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gVGFrZSB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIG9uZSBhcnJheSBhbmQgYSBudW1iZXIgb2Ygb3RoZXIgYXJyYXlzLlxuICAvLyBPbmx5IHRoZSBlbGVtZW50cyBwcmVzZW50IGluIGp1c3QgdGhlIGZpcnN0IGFycmF5IHdpbGwgcmVtYWluLlxuICBfLmRpZmZlcmVuY2UgPSBmdW5jdGlvbihhcnJheSkge1xuICAgIHZhciByZXN0ID0gY29uY2F0LmFwcGx5KEFycmF5UHJvdG8sIHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgcmV0dXJuIF8uZmlsdGVyKGFycmF5LCBmdW5jdGlvbih2YWx1ZSl7IHJldHVybiAhXy5jb250YWlucyhyZXN0LCB2YWx1ZSk7IH0pO1xuICB9O1xuXG4gIC8vIFppcCB0b2dldGhlciBtdWx0aXBsZSBsaXN0cyBpbnRvIGEgc2luZ2xlIGFycmF5IC0tIGVsZW1lbnRzIHRoYXQgc2hhcmVcbiAgLy8gYW4gaW5kZXggZ28gdG9nZXRoZXIuXG4gIF8uemlwID0gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGxlbmd0aCA9IF8ubWF4KF8ucGx1Y2soYXJndW1lbnRzLCBcImxlbmd0aFwiKS5jb25jYXQoMCkpO1xuICAgIHZhciByZXN1bHRzID0gbmV3IEFycmF5KGxlbmd0aCk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgcmVzdWx0c1tpXSA9IF8ucGx1Y2soYXJndW1lbnRzLCAnJyArIGkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfTtcblxuICAvLyBDb252ZXJ0cyBsaXN0cyBpbnRvIG9iamVjdHMuIFBhc3MgZWl0aGVyIGEgc2luZ2xlIGFycmF5IG9mIGBba2V5LCB2YWx1ZV1gXG4gIC8vIHBhaXJzLCBvciB0d28gcGFyYWxsZWwgYXJyYXlzIG9mIHRoZSBzYW1lIGxlbmd0aCAtLSBvbmUgb2Yga2V5cywgYW5kIG9uZSBvZlxuICAvLyB0aGUgY29ycmVzcG9uZGluZyB2YWx1ZXMuXG4gIF8ub2JqZWN0ID0gZnVuY3Rpb24obGlzdCwgdmFsdWVzKSB7XG4gICAgaWYgKGxpc3QgPT0gbnVsbCkgcmV0dXJuIHt9O1xuICAgIHZhciByZXN1bHQgPSB7fTtcbiAgICBmb3IgKHZhciBpID0gMCwgbGVuZ3RoID0gbGlzdC5sZW5ndGg7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgaWYgKHZhbHVlcykge1xuICAgICAgICByZXN1bHRbbGlzdFtpXV0gPSB2YWx1ZXNbaV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN1bHRbbGlzdFtpXVswXV0gPSBsaXN0W2ldWzFdO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xuXG4gIC8vIElmIHRoZSBicm93c2VyIGRvZXNuJ3Qgc3VwcGx5IHVzIHdpdGggaW5kZXhPZiAoSSdtIGxvb2tpbmcgYXQgeW91LCAqKk1TSUUqKiksXG4gIC8vIHdlIG5lZWQgdGhpcyBmdW5jdGlvbi4gUmV0dXJuIHRoZSBwb3NpdGlvbiBvZiB0aGUgZmlyc3Qgb2NjdXJyZW5jZSBvZiBhblxuICAvLyBpdGVtIGluIGFuIGFycmF5LCBvciAtMSBpZiB0aGUgaXRlbSBpcyBub3QgaW5jbHVkZWQgaW4gdGhlIGFycmF5LlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgaW5kZXhPZmAgaWYgYXZhaWxhYmxlLlxuICAvLyBJZiB0aGUgYXJyYXkgaXMgbGFyZ2UgYW5kIGFscmVhZHkgaW4gc29ydCBvcmRlciwgcGFzcyBgdHJ1ZWBcbiAgLy8gZm9yICoqaXNTb3J0ZWQqKiB0byB1c2UgYmluYXJ5IHNlYXJjaC5cbiAgXy5pbmRleE9mID0gZnVuY3Rpb24oYXJyYXksIGl0ZW0sIGlzU29ydGVkKSB7XG4gICAgaWYgKGFycmF5ID09IG51bGwpIHJldHVybiAtMTtcbiAgICB2YXIgaSA9IDAsIGxlbmd0aCA9IGFycmF5Lmxlbmd0aDtcbiAgICBpZiAoaXNTb3J0ZWQpIHtcbiAgICAgIGlmICh0eXBlb2YgaXNTb3J0ZWQgPT0gJ251bWJlcicpIHtcbiAgICAgICAgaSA9IChpc1NvcnRlZCA8IDAgPyBNYXRoLm1heCgwLCBsZW5ndGggKyBpc1NvcnRlZCkgOiBpc1NvcnRlZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpID0gXy5zb3J0ZWRJbmRleChhcnJheSwgaXRlbSk7XG4gICAgICAgIHJldHVybiBhcnJheVtpXSA9PT0gaXRlbSA/IGkgOiAtMTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG5hdGl2ZUluZGV4T2YgJiYgYXJyYXkuaW5kZXhPZiA9PT0gbmF0aXZlSW5kZXhPZikgcmV0dXJuIGFycmF5LmluZGV4T2YoaXRlbSwgaXNTb3J0ZWQpO1xuICAgIGZvciAoOyBpIDwgbGVuZ3RoOyBpKyspIGlmIChhcnJheVtpXSA9PT0gaXRlbSkgcmV0dXJuIGk7XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBsYXN0SW5kZXhPZmAgaWYgYXZhaWxhYmxlLlxuICBfLmxhc3RJbmRleE9mID0gZnVuY3Rpb24oYXJyYXksIGl0ZW0sIGZyb20pIHtcbiAgICBpZiAoYXJyYXkgPT0gbnVsbCkgcmV0dXJuIC0xO1xuICAgIHZhciBoYXNJbmRleCA9IGZyb20gIT0gbnVsbDtcbiAgICBpZiAobmF0aXZlTGFzdEluZGV4T2YgJiYgYXJyYXkubGFzdEluZGV4T2YgPT09IG5hdGl2ZUxhc3RJbmRleE9mKSB7XG4gICAgICByZXR1cm4gaGFzSW5kZXggPyBhcnJheS5sYXN0SW5kZXhPZihpdGVtLCBmcm9tKSA6IGFycmF5Lmxhc3RJbmRleE9mKGl0ZW0pO1xuICAgIH1cbiAgICB2YXIgaSA9IChoYXNJbmRleCA/IGZyb20gOiBhcnJheS5sZW5ndGgpO1xuICAgIHdoaWxlIChpLS0pIGlmIChhcnJheVtpXSA9PT0gaXRlbSkgcmV0dXJuIGk7XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIC8vIEdlbmVyYXRlIGFuIGludGVnZXIgQXJyYXkgY29udGFpbmluZyBhbiBhcml0aG1ldGljIHByb2dyZXNzaW9uLiBBIHBvcnQgb2ZcbiAgLy8gdGhlIG5hdGl2ZSBQeXRob24gYHJhbmdlKClgIGZ1bmN0aW9uLiBTZWVcbiAgLy8gW3RoZSBQeXRob24gZG9jdW1lbnRhdGlvbl0oaHR0cDovL2RvY3MucHl0aG9uLm9yZy9saWJyYXJ5L2Z1bmN0aW9ucy5odG1sI3JhbmdlKS5cbiAgXy5yYW5nZSA9IGZ1bmN0aW9uKHN0YXJ0LCBzdG9wLCBzdGVwKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPD0gMSkge1xuICAgICAgc3RvcCA9IHN0YXJ0IHx8IDA7XG4gICAgICBzdGFydCA9IDA7XG4gICAgfVxuICAgIHN0ZXAgPSBhcmd1bWVudHNbMl0gfHwgMTtcblxuICAgIHZhciBsZW5ndGggPSBNYXRoLm1heChNYXRoLmNlaWwoKHN0b3AgLSBzdGFydCkgLyBzdGVwKSwgMCk7XG4gICAgdmFyIGlkeCA9IDA7XG4gICAgdmFyIHJhbmdlID0gbmV3IEFycmF5KGxlbmd0aCk7XG5cbiAgICB3aGlsZShpZHggPCBsZW5ndGgpIHtcbiAgICAgIHJhbmdlW2lkeCsrXSA9IHN0YXJ0O1xuICAgICAgc3RhcnQgKz0gc3RlcDtcbiAgICB9XG5cbiAgICByZXR1cm4gcmFuZ2U7XG4gIH07XG5cbiAgLy8gRnVuY3Rpb24gKGFoZW0pIEZ1bmN0aW9uc1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS1cblxuICAvLyBSZXVzYWJsZSBjb25zdHJ1Y3RvciBmdW5jdGlvbiBmb3IgcHJvdG90eXBlIHNldHRpbmcuXG4gIHZhciBjdG9yID0gZnVuY3Rpb24oKXt9O1xuXG4gIC8vIENyZWF0ZSBhIGZ1bmN0aW9uIGJvdW5kIHRvIGEgZ2l2ZW4gb2JqZWN0IChhc3NpZ25pbmcgYHRoaXNgLCBhbmQgYXJndW1lbnRzLFxuICAvLyBvcHRpb25hbGx5KS4gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYEZ1bmN0aW9uLmJpbmRgIGlmXG4gIC8vIGF2YWlsYWJsZS5cbiAgXy5iaW5kID0gZnVuY3Rpb24oZnVuYywgY29udGV4dCkge1xuICAgIHZhciBhcmdzLCBib3VuZDtcbiAgICBpZiAobmF0aXZlQmluZCAmJiBmdW5jLmJpbmQgPT09IG5hdGl2ZUJpbmQpIHJldHVybiBuYXRpdmVCaW5kLmFwcGx5KGZ1bmMsIHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgaWYgKCFfLmlzRnVuY3Rpb24oZnVuYykpIHRocm93IG5ldyBUeXBlRXJyb3I7XG4gICAgYXJncyA9IHNsaWNlLmNhbGwoYXJndW1lbnRzLCAyKTtcbiAgICByZXR1cm4gYm91bmQgPSBmdW5jdGlvbigpIHtcbiAgICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBib3VuZCkpIHJldHVybiBmdW5jLmFwcGx5KGNvbnRleHQsIGFyZ3MuY29uY2F0KHNsaWNlLmNhbGwoYXJndW1lbnRzKSkpO1xuICAgICAgY3Rvci5wcm90b3R5cGUgPSBmdW5jLnByb3RvdHlwZTtcbiAgICAgIHZhciBzZWxmID0gbmV3IGN0b3I7XG4gICAgICBjdG9yLnByb3RvdHlwZSA9IG51bGw7XG4gICAgICB2YXIgcmVzdWx0ID0gZnVuYy5hcHBseShzZWxmLCBhcmdzLmNvbmNhdChzbGljZS5jYWxsKGFyZ3VtZW50cykpKTtcbiAgICAgIGlmIChPYmplY3QocmVzdWx0KSA9PT0gcmVzdWx0KSByZXR1cm4gcmVzdWx0O1xuICAgICAgcmV0dXJuIHNlbGY7XG4gICAgfTtcbiAgfTtcblxuICAvLyBQYXJ0aWFsbHkgYXBwbHkgYSBmdW5jdGlvbiBieSBjcmVhdGluZyBhIHZlcnNpb24gdGhhdCBoYXMgaGFkIHNvbWUgb2YgaXRzXG4gIC8vIGFyZ3VtZW50cyBwcmUtZmlsbGVkLCB3aXRob3V0IGNoYW5naW5nIGl0cyBkeW5hbWljIGB0aGlzYCBjb250ZXh0LlxuICBfLnBhcnRpYWwgPSBmdW5jdGlvbihmdW5jKSB7XG4gICAgdmFyIGFyZ3MgPSBzbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGZ1bmMuYXBwbHkodGhpcywgYXJncy5jb25jYXQoc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gICAgfTtcbiAgfTtcblxuICAvLyBCaW5kIGFsbCBvZiBhbiBvYmplY3QncyBtZXRob2RzIHRvIHRoYXQgb2JqZWN0LiBVc2VmdWwgZm9yIGVuc3VyaW5nIHRoYXRcbiAgLy8gYWxsIGNhbGxiYWNrcyBkZWZpbmVkIG9uIGFuIG9iamVjdCBiZWxvbmcgdG8gaXQuXG4gIF8uYmluZEFsbCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciBmdW5jcyA9IHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICBpZiAoZnVuY3MubGVuZ3RoID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoXCJiaW5kQWxsIG11c3QgYmUgcGFzc2VkIGZ1bmN0aW9uIG5hbWVzXCIpO1xuICAgIGVhY2goZnVuY3MsIGZ1bmN0aW9uKGYpIHsgb2JqW2ZdID0gXy5iaW5kKG9ialtmXSwgb2JqKTsgfSk7XG4gICAgcmV0dXJuIG9iajtcbiAgfTtcblxuICAvLyBNZW1vaXplIGFuIGV4cGVuc2l2ZSBmdW5jdGlvbiBieSBzdG9yaW5nIGl0cyByZXN1bHRzLlxuICBfLm1lbW9pemUgPSBmdW5jdGlvbihmdW5jLCBoYXNoZXIpIHtcbiAgICB2YXIgbWVtbyA9IHt9O1xuICAgIGhhc2hlciB8fCAoaGFzaGVyID0gXy5pZGVudGl0eSk7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGtleSA9IGhhc2hlci5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgcmV0dXJuIF8uaGFzKG1lbW8sIGtleSkgPyBtZW1vW2tleV0gOiAobWVtb1trZXldID0gZnVuYy5hcHBseSh0aGlzLCBhcmd1bWVudHMpKTtcbiAgICB9O1xuICB9O1xuXG4gIC8vIERlbGF5cyBhIGZ1bmN0aW9uIGZvciB0aGUgZ2l2ZW4gbnVtYmVyIG9mIG1pbGxpc2Vjb25kcywgYW5kIHRoZW4gY2FsbHNcbiAgLy8gaXQgd2l0aCB0aGUgYXJndW1lbnRzIHN1cHBsaWVkLlxuICBfLmRlbGF5ID0gZnVuY3Rpb24oZnVuYywgd2FpdCkge1xuICAgIHZhciBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgIHJldHVybiBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7IHJldHVybiBmdW5jLmFwcGx5KG51bGwsIGFyZ3MpOyB9LCB3YWl0KTtcbiAgfTtcblxuICAvLyBEZWZlcnMgYSBmdW5jdGlvbiwgc2NoZWR1bGluZyBpdCB0byBydW4gYWZ0ZXIgdGhlIGN1cnJlbnQgY2FsbCBzdGFjayBoYXNcbiAgLy8gY2xlYXJlZC5cbiAgXy5kZWZlciA9IGZ1bmN0aW9uKGZ1bmMpIHtcbiAgICByZXR1cm4gXy5kZWxheS5hcHBseShfLCBbZnVuYywgMV0uY29uY2F0KHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSkpO1xuICB9O1xuXG4gIC8vIFJldHVybnMgYSBmdW5jdGlvbiwgdGhhdCwgd2hlbiBpbnZva2VkLCB3aWxsIG9ubHkgYmUgdHJpZ2dlcmVkIGF0IG1vc3Qgb25jZVxuICAvLyBkdXJpbmcgYSBnaXZlbiB3aW5kb3cgb2YgdGltZS4gTm9ybWFsbHksIHRoZSB0aHJvdHRsZWQgZnVuY3Rpb24gd2lsbCBydW5cbiAgLy8gYXMgbXVjaCBhcyBpdCBjYW4sIHdpdGhvdXQgZXZlciBnb2luZyBtb3JlIHRoYW4gb25jZSBwZXIgYHdhaXRgIGR1cmF0aW9uO1xuICAvLyBidXQgaWYgeW91J2QgbGlrZSB0byBkaXNhYmxlIHRoZSBleGVjdXRpb24gb24gdGhlIGxlYWRpbmcgZWRnZSwgcGFzc1xuICAvLyBge2xlYWRpbmc6IGZhbHNlfWAuIFRvIGRpc2FibGUgZXhlY3V0aW9uIG9uIHRoZSB0cmFpbGluZyBlZGdlLCBkaXR0by5cbiAgXy50aHJvdHRsZSA9IGZ1bmN0aW9uKGZ1bmMsIHdhaXQsIG9wdGlvbnMpIHtcbiAgICB2YXIgY29udGV4dCwgYXJncywgcmVzdWx0O1xuICAgIHZhciB0aW1lb3V0ID0gbnVsbDtcbiAgICB2YXIgcHJldmlvdXMgPSAwO1xuICAgIG9wdGlvbnMgfHwgKG9wdGlvbnMgPSB7fSk7XG4gICAgdmFyIGxhdGVyID0gZnVuY3Rpb24oKSB7XG4gICAgICBwcmV2aW91cyA9IG9wdGlvbnMubGVhZGluZyA9PT0gZmFsc2UgPyAwIDogbmV3IERhdGU7XG4gICAgICB0aW1lb3V0ID0gbnVsbDtcbiAgICAgIHJlc3VsdCA9IGZ1bmMuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgfTtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgbm93ID0gbmV3IERhdGU7XG4gICAgICBpZiAoIXByZXZpb3VzICYmIG9wdGlvbnMubGVhZGluZyA9PT0gZmFsc2UpIHByZXZpb3VzID0gbm93O1xuICAgICAgdmFyIHJlbWFpbmluZyA9IHdhaXQgLSAobm93IC0gcHJldmlvdXMpO1xuICAgICAgY29udGV4dCA9IHRoaXM7XG4gICAgICBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgaWYgKHJlbWFpbmluZyA8PSAwKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgICAgdGltZW91dCA9IG51bGw7XG4gICAgICAgIHByZXZpb3VzID0gbm93O1xuICAgICAgICByZXN1bHQgPSBmdW5jLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgfSBlbHNlIGlmICghdGltZW91dCAmJiBvcHRpb25zLnRyYWlsaW5nICE9PSBmYWxzZSkge1xuICAgICAgICB0aW1lb3V0ID0gc2V0VGltZW91dChsYXRlciwgcmVtYWluaW5nKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgfTtcblxuICAvLyBSZXR1cm5zIGEgZnVuY3Rpb24sIHRoYXQsIGFzIGxvbmcgYXMgaXQgY29udGludWVzIHRvIGJlIGludm9rZWQsIHdpbGwgbm90XG4gIC8vIGJlIHRyaWdnZXJlZC4gVGhlIGZ1bmN0aW9uIHdpbGwgYmUgY2FsbGVkIGFmdGVyIGl0IHN0b3BzIGJlaW5nIGNhbGxlZCBmb3JcbiAgLy8gTiBtaWxsaXNlY29uZHMuIElmIGBpbW1lZGlhdGVgIGlzIHBhc3NlZCwgdHJpZ2dlciB0aGUgZnVuY3Rpb24gb24gdGhlXG4gIC8vIGxlYWRpbmcgZWRnZSwgaW5zdGVhZCBvZiB0aGUgdHJhaWxpbmcuXG4gIF8uZGVib3VuY2UgPSBmdW5jdGlvbihmdW5jLCB3YWl0LCBpbW1lZGlhdGUpIHtcbiAgICB2YXIgdGltZW91dCwgYXJncywgY29udGV4dCwgdGltZXN0YW1wLCByZXN1bHQ7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgY29udGV4dCA9IHRoaXM7XG4gICAgICBhcmdzID0gYXJndW1lbnRzO1xuICAgICAgdGltZXN0YW1wID0gbmV3IERhdGUoKTtcbiAgICAgIHZhciBsYXRlciA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgbGFzdCA9IChuZXcgRGF0ZSgpKSAtIHRpbWVzdGFtcDtcbiAgICAgICAgaWYgKGxhc3QgPCB3YWl0KSB7XG4gICAgICAgICAgdGltZW91dCA9IHNldFRpbWVvdXQobGF0ZXIsIHdhaXQgLSBsYXN0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aW1lb3V0ID0gbnVsbDtcbiAgICAgICAgICBpZiAoIWltbWVkaWF0ZSkgcmVzdWx0ID0gZnVuYy5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHZhciBjYWxsTm93ID0gaW1tZWRpYXRlICYmICF0aW1lb3V0O1xuICAgICAgaWYgKCF0aW1lb3V0KSB7XG4gICAgICAgIHRpbWVvdXQgPSBzZXRUaW1lb3V0KGxhdGVyLCB3YWl0KTtcbiAgICAgIH1cbiAgICAgIGlmIChjYWxsTm93KSByZXN1bHQgPSBmdW5jLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICB9O1xuXG4gIC8vIFJldHVybnMgYSBmdW5jdGlvbiB0aGF0IHdpbGwgYmUgZXhlY3V0ZWQgYXQgbW9zdCBvbmUgdGltZSwgbm8gbWF0dGVyIGhvd1xuICAvLyBvZnRlbiB5b3UgY2FsbCBpdC4gVXNlZnVsIGZvciBsYXp5IGluaXRpYWxpemF0aW9uLlxuICBfLm9uY2UgPSBmdW5jdGlvbihmdW5jKSB7XG4gICAgdmFyIHJhbiA9IGZhbHNlLCBtZW1vO1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIGlmIChyYW4pIHJldHVybiBtZW1vO1xuICAgICAgcmFuID0gdHJ1ZTtcbiAgICAgIG1lbW8gPSBmdW5jLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICBmdW5jID0gbnVsbDtcbiAgICAgIHJldHVybiBtZW1vO1xuICAgIH07XG4gIH07XG5cbiAgLy8gUmV0dXJucyB0aGUgZmlyc3QgZnVuY3Rpb24gcGFzc2VkIGFzIGFuIGFyZ3VtZW50IHRvIHRoZSBzZWNvbmQsXG4gIC8vIGFsbG93aW5nIHlvdSB0byBhZGp1c3QgYXJndW1lbnRzLCBydW4gY29kZSBiZWZvcmUgYW5kIGFmdGVyLCBhbmRcbiAgLy8gY29uZGl0aW9uYWxseSBleGVjdXRlIHRoZSBvcmlnaW5hbCBmdW5jdGlvbi5cbiAgXy53cmFwID0gZnVuY3Rpb24oZnVuYywgd3JhcHBlcikge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBhcmdzID0gW2Z1bmNdO1xuICAgICAgcHVzaC5hcHBseShhcmdzLCBhcmd1bWVudHMpO1xuICAgICAgcmV0dXJuIHdyYXBwZXIuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfTtcbiAgfTtcblxuICAvLyBSZXR1cm5zIGEgZnVuY3Rpb24gdGhhdCBpcyB0aGUgY29tcG9zaXRpb24gb2YgYSBsaXN0IG9mIGZ1bmN0aW9ucywgZWFjaFxuICAvLyBjb25zdW1pbmcgdGhlIHJldHVybiB2YWx1ZSBvZiB0aGUgZnVuY3Rpb24gdGhhdCBmb2xsb3dzLlxuICBfLmNvbXBvc2UgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgZnVuY3MgPSBhcmd1bWVudHM7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICBmb3IgKHZhciBpID0gZnVuY3MubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgYXJncyA9IFtmdW5jc1tpXS5hcHBseSh0aGlzLCBhcmdzKV07XG4gICAgICB9XG4gICAgICByZXR1cm4gYXJnc1swXTtcbiAgICB9O1xuICB9O1xuXG4gIC8vIFJldHVybnMgYSBmdW5jdGlvbiB0aGF0IHdpbGwgb25seSBiZSBleGVjdXRlZCBhZnRlciBiZWluZyBjYWxsZWQgTiB0aW1lcy5cbiAgXy5hZnRlciA9IGZ1bmN0aW9uKHRpbWVzLCBmdW5jKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKC0tdGltZXMgPCAxKSB7XG4gICAgICAgIHJldHVybiBmdW5jLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICB9XG4gICAgfTtcbiAgfTtcblxuICAvLyBPYmplY3QgRnVuY3Rpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS1cblxuICAvLyBSZXRyaWV2ZSB0aGUgbmFtZXMgb2YgYW4gb2JqZWN0J3MgcHJvcGVydGllcy5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYE9iamVjdC5rZXlzYFxuICBfLmtleXMgPSBuYXRpdmVLZXlzIHx8IGZ1bmN0aW9uKG9iaikge1xuICAgIGlmIChvYmogIT09IE9iamVjdChvYmopKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIG9iamVjdCcpO1xuICAgIHZhciBrZXlzID0gW107XG4gICAgZm9yICh2YXIga2V5IGluIG9iaikgaWYgKF8uaGFzKG9iaiwga2V5KSkga2V5cy5wdXNoKGtleSk7XG4gICAgcmV0dXJuIGtleXM7XG4gIH07XG5cbiAgLy8gUmV0cmlldmUgdGhlIHZhbHVlcyBvZiBhbiBvYmplY3QncyBwcm9wZXJ0aWVzLlxuICBfLnZhbHVlcyA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciBrZXlzID0gXy5rZXlzKG9iaik7XG4gICAgdmFyIGxlbmd0aCA9IGtleXMubGVuZ3RoO1xuICAgIHZhciB2YWx1ZXMgPSBuZXcgQXJyYXkobGVuZ3RoKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICB2YWx1ZXNbaV0gPSBvYmpba2V5c1tpXV07XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZXM7XG4gIH07XG5cbiAgLy8gQ29udmVydCBhbiBvYmplY3QgaW50byBhIGxpc3Qgb2YgYFtrZXksIHZhbHVlXWAgcGFpcnMuXG4gIF8ucGFpcnMgPSBmdW5jdGlvbihvYmopIHtcbiAgICB2YXIga2V5cyA9IF8ua2V5cyhvYmopO1xuICAgIHZhciBsZW5ndGggPSBrZXlzLmxlbmd0aDtcbiAgICB2YXIgcGFpcnMgPSBuZXcgQXJyYXkobGVuZ3RoKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICBwYWlyc1tpXSA9IFtrZXlzW2ldLCBvYmpba2V5c1tpXV1dO1xuICAgIH1cbiAgICByZXR1cm4gcGFpcnM7XG4gIH07XG5cbiAgLy8gSW52ZXJ0IHRoZSBrZXlzIGFuZCB2YWx1ZXMgb2YgYW4gb2JqZWN0LiBUaGUgdmFsdWVzIG11c3QgYmUgc2VyaWFsaXphYmxlLlxuICBfLmludmVydCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciByZXN1bHQgPSB7fTtcbiAgICB2YXIga2V5cyA9IF8ua2V5cyhvYmopO1xuICAgIGZvciAodmFyIGkgPSAwLCBsZW5ndGggPSBrZXlzLmxlbmd0aDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICByZXN1bHRbb2JqW2tleXNbaV1dXSA9IGtleXNbaV07XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG5cbiAgLy8gUmV0dXJuIGEgc29ydGVkIGxpc3Qgb2YgdGhlIGZ1bmN0aW9uIG5hbWVzIGF2YWlsYWJsZSBvbiB0aGUgb2JqZWN0LlxuICAvLyBBbGlhc2VkIGFzIGBtZXRob2RzYFxuICBfLmZ1bmN0aW9ucyA9IF8ubWV0aG9kcyA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciBuYW1lcyA9IFtdO1xuICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgIGlmIChfLmlzRnVuY3Rpb24ob2JqW2tleV0pKSBuYW1lcy5wdXNoKGtleSk7XG4gICAgfVxuICAgIHJldHVybiBuYW1lcy5zb3J0KCk7XG4gIH07XG5cbiAgLy8gRXh0ZW5kIGEgZ2l2ZW4gb2JqZWN0IHdpdGggYWxsIHRoZSBwcm9wZXJ0aWVzIGluIHBhc3NlZC1pbiBvYmplY3QocykuXG4gIF8uZXh0ZW5kID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgZWFjaChzbGljZS5jYWxsKGFyZ3VtZW50cywgMSksIGZ1bmN0aW9uKHNvdXJjZSkge1xuICAgICAgaWYgKHNvdXJjZSkge1xuICAgICAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgICAgIG9ialtwcm9wXSA9IHNvdXJjZVtwcm9wXTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiBvYmo7XG4gIH07XG5cbiAgLy8gUmV0dXJuIGEgY29weSBvZiB0aGUgb2JqZWN0IG9ubHkgY29udGFpbmluZyB0aGUgd2hpdGVsaXN0ZWQgcHJvcGVydGllcy5cbiAgXy5waWNrID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIGNvcHkgPSB7fTtcbiAgICB2YXIga2V5cyA9IGNvbmNhdC5hcHBseShBcnJheVByb3RvLCBzbGljZS5jYWxsKGFyZ3VtZW50cywgMSkpO1xuICAgIGVhY2goa2V5cywgZnVuY3Rpb24oa2V5KSB7XG4gICAgICBpZiAoa2V5IGluIG9iaikgY29weVtrZXldID0gb2JqW2tleV07XG4gICAgfSk7XG4gICAgcmV0dXJuIGNvcHk7XG4gIH07XG5cbiAgIC8vIFJldHVybiBhIGNvcHkgb2YgdGhlIG9iamVjdCB3aXRob3V0IHRoZSBibGFja2xpc3RlZCBwcm9wZXJ0aWVzLlxuICBfLm9taXQgPSBmdW5jdGlvbihvYmopIHtcbiAgICB2YXIgY29weSA9IHt9O1xuICAgIHZhciBrZXlzID0gY29uY2F0LmFwcGx5KEFycmF5UHJvdG8sIHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgaWYgKCFfLmNvbnRhaW5zKGtleXMsIGtleSkpIGNvcHlba2V5XSA9IG9ialtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gY29weTtcbiAgfTtcblxuICAvLyBGaWxsIGluIGEgZ2l2ZW4gb2JqZWN0IHdpdGggZGVmYXVsdCBwcm9wZXJ0aWVzLlxuICBfLmRlZmF1bHRzID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgZWFjaChzbGljZS5jYWxsKGFyZ3VtZW50cywgMSksIGZ1bmN0aW9uKHNvdXJjZSkge1xuICAgICAgaWYgKHNvdXJjZSkge1xuICAgICAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgICAgIGlmIChvYmpbcHJvcF0gPT09IHZvaWQgMCkgb2JqW3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIG9iajtcbiAgfTtcblxuICAvLyBDcmVhdGUgYSAoc2hhbGxvdy1jbG9uZWQpIGR1cGxpY2F0ZSBvZiBhbiBvYmplY3QuXG4gIF8uY2xvbmUgPSBmdW5jdGlvbihvYmopIHtcbiAgICBpZiAoIV8uaXNPYmplY3Qob2JqKSkgcmV0dXJuIG9iajtcbiAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgPyBvYmouc2xpY2UoKSA6IF8uZXh0ZW5kKHt9LCBvYmopO1xuICB9O1xuXG4gIC8vIEludm9rZXMgaW50ZXJjZXB0b3Igd2l0aCB0aGUgb2JqLCBhbmQgdGhlbiByZXR1cm5zIG9iai5cbiAgLy8gVGhlIHByaW1hcnkgcHVycG9zZSBvZiB0aGlzIG1ldGhvZCBpcyB0byBcInRhcCBpbnRvXCIgYSBtZXRob2QgY2hhaW4sIGluXG4gIC8vIG9yZGVyIHRvIHBlcmZvcm0gb3BlcmF0aW9ucyBvbiBpbnRlcm1lZGlhdGUgcmVzdWx0cyB3aXRoaW4gdGhlIGNoYWluLlxuICBfLnRhcCA9IGZ1bmN0aW9uKG9iaiwgaW50ZXJjZXB0b3IpIHtcbiAgICBpbnRlcmNlcHRvcihvYmopO1xuICAgIHJldHVybiBvYmo7XG4gIH07XG5cbiAgLy8gSW50ZXJuYWwgcmVjdXJzaXZlIGNvbXBhcmlzb24gZnVuY3Rpb24gZm9yIGBpc0VxdWFsYC5cbiAgdmFyIGVxID0gZnVuY3Rpb24oYSwgYiwgYVN0YWNrLCBiU3RhY2spIHtcbiAgICAvLyBJZGVudGljYWwgb2JqZWN0cyBhcmUgZXF1YWwuIGAwID09PSAtMGAsIGJ1dCB0aGV5IGFyZW4ndCBpZGVudGljYWwuXG4gICAgLy8gU2VlIHRoZSBbSGFybW9ueSBgZWdhbGAgcHJvcG9zYWxdKGh0dHA6Ly93aWtpLmVjbWFzY3JpcHQub3JnL2Rva3UucGhwP2lkPWhhcm1vbnk6ZWdhbCkuXG4gICAgaWYgKGEgPT09IGIpIHJldHVybiBhICE9PSAwIHx8IDEgLyBhID09IDEgLyBiO1xuICAgIC8vIEEgc3RyaWN0IGNvbXBhcmlzb24gaXMgbmVjZXNzYXJ5IGJlY2F1c2UgYG51bGwgPT0gdW5kZWZpbmVkYC5cbiAgICBpZiAoYSA9PSBudWxsIHx8IGIgPT0gbnVsbCkgcmV0dXJuIGEgPT09IGI7XG4gICAgLy8gVW53cmFwIGFueSB3cmFwcGVkIG9iamVjdHMuXG4gICAgaWYgKGEgaW5zdGFuY2VvZiBfKSBhID0gYS5fd3JhcHBlZDtcbiAgICBpZiAoYiBpbnN0YW5jZW9mIF8pIGIgPSBiLl93cmFwcGVkO1xuICAgIC8vIENvbXBhcmUgYFtbQ2xhc3NdXWAgbmFtZXMuXG4gICAgdmFyIGNsYXNzTmFtZSA9IHRvU3RyaW5nLmNhbGwoYSk7XG4gICAgaWYgKGNsYXNzTmFtZSAhPSB0b1N0cmluZy5jYWxsKGIpKSByZXR1cm4gZmFsc2U7XG4gICAgc3dpdGNoIChjbGFzc05hbWUpIHtcbiAgICAgIC8vIFN0cmluZ3MsIG51bWJlcnMsIGRhdGVzLCBhbmQgYm9vbGVhbnMgYXJlIGNvbXBhcmVkIGJ5IHZhbHVlLlxuICAgICAgY2FzZSAnW29iamVjdCBTdHJpbmddJzpcbiAgICAgICAgLy8gUHJpbWl0aXZlcyBhbmQgdGhlaXIgY29ycmVzcG9uZGluZyBvYmplY3Qgd3JhcHBlcnMgYXJlIGVxdWl2YWxlbnQ7IHRodXMsIGBcIjVcImAgaXNcbiAgICAgICAgLy8gZXF1aXZhbGVudCB0byBgbmV3IFN0cmluZyhcIjVcIilgLlxuICAgICAgICByZXR1cm4gYSA9PSBTdHJpbmcoYik7XG4gICAgICBjYXNlICdbb2JqZWN0IE51bWJlcl0nOlxuICAgICAgICAvLyBgTmFOYHMgYXJlIGVxdWl2YWxlbnQsIGJ1dCBub24tcmVmbGV4aXZlLiBBbiBgZWdhbGAgY29tcGFyaXNvbiBpcyBwZXJmb3JtZWQgZm9yXG4gICAgICAgIC8vIG90aGVyIG51bWVyaWMgdmFsdWVzLlxuICAgICAgICByZXR1cm4gYSAhPSArYSA/IGIgIT0gK2IgOiAoYSA9PSAwID8gMSAvIGEgPT0gMSAvIGIgOiBhID09ICtiKTtcbiAgICAgIGNhc2UgJ1tvYmplY3QgRGF0ZV0nOlxuICAgICAgY2FzZSAnW29iamVjdCBCb29sZWFuXSc6XG4gICAgICAgIC8vIENvZXJjZSBkYXRlcyBhbmQgYm9vbGVhbnMgdG8gbnVtZXJpYyBwcmltaXRpdmUgdmFsdWVzLiBEYXRlcyBhcmUgY29tcGFyZWQgYnkgdGhlaXJcbiAgICAgICAgLy8gbWlsbGlzZWNvbmQgcmVwcmVzZW50YXRpb25zLiBOb3RlIHRoYXQgaW52YWxpZCBkYXRlcyB3aXRoIG1pbGxpc2Vjb25kIHJlcHJlc2VudGF0aW9uc1xuICAgICAgICAvLyBvZiBgTmFOYCBhcmUgbm90IGVxdWl2YWxlbnQuXG4gICAgICAgIHJldHVybiArYSA9PSArYjtcbiAgICAgIC8vIFJlZ0V4cHMgYXJlIGNvbXBhcmVkIGJ5IHRoZWlyIHNvdXJjZSBwYXR0ZXJucyBhbmQgZmxhZ3MuXG4gICAgICBjYXNlICdbb2JqZWN0IFJlZ0V4cF0nOlxuICAgICAgICByZXR1cm4gYS5zb3VyY2UgPT0gYi5zb3VyY2UgJiZcbiAgICAgICAgICAgICAgIGEuZ2xvYmFsID09IGIuZ2xvYmFsICYmXG4gICAgICAgICAgICAgICBhLm11bHRpbGluZSA9PSBiLm11bHRpbGluZSAmJlxuICAgICAgICAgICAgICAgYS5pZ25vcmVDYXNlID09IGIuaWdub3JlQ2FzZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBhICE9ICdvYmplY3QnIHx8IHR5cGVvZiBiICE9ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG4gICAgLy8gQXNzdW1lIGVxdWFsaXR5IGZvciBjeWNsaWMgc3RydWN0dXJlcy4gVGhlIGFsZ29yaXRobSBmb3IgZGV0ZWN0aW5nIGN5Y2xpY1xuICAgIC8vIHN0cnVjdHVyZXMgaXMgYWRhcHRlZCBmcm9tIEVTIDUuMSBzZWN0aW9uIDE1LjEyLjMsIGFic3RyYWN0IG9wZXJhdGlvbiBgSk9gLlxuICAgIHZhciBsZW5ndGggPSBhU3RhY2subGVuZ3RoO1xuICAgIHdoaWxlIChsZW5ndGgtLSkge1xuICAgICAgLy8gTGluZWFyIHNlYXJjaC4gUGVyZm9ybWFuY2UgaXMgaW52ZXJzZWx5IHByb3BvcnRpb25hbCB0byB0aGUgbnVtYmVyIG9mXG4gICAgICAvLyB1bmlxdWUgbmVzdGVkIHN0cnVjdHVyZXMuXG4gICAgICBpZiAoYVN0YWNrW2xlbmd0aF0gPT0gYSkgcmV0dXJuIGJTdGFja1tsZW5ndGhdID09IGI7XG4gICAgfVxuICAgIC8vIE9iamVjdHMgd2l0aCBkaWZmZXJlbnQgY29uc3RydWN0b3JzIGFyZSBub3QgZXF1aXZhbGVudCwgYnV0IGBPYmplY3Rgc1xuICAgIC8vIGZyb20gZGlmZmVyZW50IGZyYW1lcyBhcmUuXG4gICAgdmFyIGFDdG9yID0gYS5jb25zdHJ1Y3RvciwgYkN0b3IgPSBiLmNvbnN0cnVjdG9yO1xuICAgIGlmIChhQ3RvciAhPT0gYkN0b3IgJiYgIShfLmlzRnVuY3Rpb24oYUN0b3IpICYmIChhQ3RvciBpbnN0YW5jZW9mIGFDdG9yKSAmJlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICBfLmlzRnVuY3Rpb24oYkN0b3IpICYmIChiQ3RvciBpbnN0YW5jZW9mIGJDdG9yKSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gQWRkIHRoZSBmaXJzdCBvYmplY3QgdG8gdGhlIHN0YWNrIG9mIHRyYXZlcnNlZCBvYmplY3RzLlxuICAgIGFTdGFjay5wdXNoKGEpO1xuICAgIGJTdGFjay5wdXNoKGIpO1xuICAgIHZhciBzaXplID0gMCwgcmVzdWx0ID0gdHJ1ZTtcbiAgICAvLyBSZWN1cnNpdmVseSBjb21wYXJlIG9iamVjdHMgYW5kIGFycmF5cy5cbiAgICBpZiAoY2xhc3NOYW1lID09ICdbb2JqZWN0IEFycmF5XScpIHtcbiAgICAgIC8vIENvbXBhcmUgYXJyYXkgbGVuZ3RocyB0byBkZXRlcm1pbmUgaWYgYSBkZWVwIGNvbXBhcmlzb24gaXMgbmVjZXNzYXJ5LlxuICAgICAgc2l6ZSA9IGEubGVuZ3RoO1xuICAgICAgcmVzdWx0ID0gc2l6ZSA9PSBiLmxlbmd0aDtcbiAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgLy8gRGVlcCBjb21wYXJlIHRoZSBjb250ZW50cywgaWdub3Jpbmcgbm9uLW51bWVyaWMgcHJvcGVydGllcy5cbiAgICAgICAgd2hpbGUgKHNpemUtLSkge1xuICAgICAgICAgIGlmICghKHJlc3VsdCA9IGVxKGFbc2l6ZV0sIGJbc2l6ZV0sIGFTdGFjaywgYlN0YWNrKSkpIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIERlZXAgY29tcGFyZSBvYmplY3RzLlxuICAgICAgZm9yICh2YXIga2V5IGluIGEpIHtcbiAgICAgICAgaWYgKF8uaGFzKGEsIGtleSkpIHtcbiAgICAgICAgICAvLyBDb3VudCB0aGUgZXhwZWN0ZWQgbnVtYmVyIG9mIHByb3BlcnRpZXMuXG4gICAgICAgICAgc2l6ZSsrO1xuICAgICAgICAgIC8vIERlZXAgY29tcGFyZSBlYWNoIG1lbWJlci5cbiAgICAgICAgICBpZiAoIShyZXN1bHQgPSBfLmhhcyhiLCBrZXkpICYmIGVxKGFba2V5XSwgYltrZXldLCBhU3RhY2ssIGJTdGFjaykpKSBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gRW5zdXJlIHRoYXQgYm90aCBvYmplY3RzIGNvbnRhaW4gdGhlIHNhbWUgbnVtYmVyIG9mIHByb3BlcnRpZXMuXG4gICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgIGZvciAoa2V5IGluIGIpIHtcbiAgICAgICAgICBpZiAoXy5oYXMoYiwga2V5KSAmJiAhKHNpemUtLSkpIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIHJlc3VsdCA9ICFzaXplO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBSZW1vdmUgdGhlIGZpcnN0IG9iamVjdCBmcm9tIHRoZSBzdGFjayBvZiB0cmF2ZXJzZWQgb2JqZWN0cy5cbiAgICBhU3RhY2sucG9wKCk7XG4gICAgYlN0YWNrLnBvcCgpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG5cbiAgLy8gUGVyZm9ybSBhIGRlZXAgY29tcGFyaXNvbiB0byBjaGVjayBpZiB0d28gb2JqZWN0cyBhcmUgZXF1YWwuXG4gIF8uaXNFcXVhbCA9IGZ1bmN0aW9uKGEsIGIpIHtcbiAgICByZXR1cm4gZXEoYSwgYiwgW10sIFtdKTtcbiAgfTtcblxuICAvLyBJcyBhIGdpdmVuIGFycmF5LCBzdHJpbmcsIG9yIG9iamVjdCBlbXB0eT9cbiAgLy8gQW4gXCJlbXB0eVwiIG9iamVjdCBoYXMgbm8gZW51bWVyYWJsZSBvd24tcHJvcGVydGllcy5cbiAgXy5pc0VtcHR5ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoXy5pc0FycmF5KG9iaikgfHwgXy5pc1N0cmluZyhvYmopKSByZXR1cm4gb2JqLmxlbmd0aCA9PT0gMDtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqKSBpZiAoXy5oYXMob2JqLCBrZXkpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG5cbiAgLy8gSXMgYSBnaXZlbiB2YWx1ZSBhIERPTSBlbGVtZW50P1xuICBfLmlzRWxlbWVudCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiAhIShvYmogJiYgb2JqLm5vZGVUeXBlID09PSAxKTtcbiAgfTtcblxuICAvLyBJcyBhIGdpdmVuIHZhbHVlIGFuIGFycmF5P1xuICAvLyBEZWxlZ2F0ZXMgdG8gRUNNQTUncyBuYXRpdmUgQXJyYXkuaXNBcnJheVxuICBfLmlzQXJyYXkgPSBuYXRpdmVJc0FycmF5IHx8IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiB0b1N0cmluZy5jYWxsKG9iaikgPT0gJ1tvYmplY3QgQXJyYXldJztcbiAgfTtcblxuICAvLyBJcyBhIGdpdmVuIHZhcmlhYmxlIGFuIG9iamVjdD9cbiAgXy5pc09iamVjdCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBvYmogPT09IE9iamVjdChvYmopO1xuICB9O1xuXG4gIC8vIEFkZCBzb21lIGlzVHlwZSBtZXRob2RzOiBpc0FyZ3VtZW50cywgaXNGdW5jdGlvbiwgaXNTdHJpbmcsIGlzTnVtYmVyLCBpc0RhdGUsIGlzUmVnRXhwLlxuICBlYWNoKFsnQXJndW1lbnRzJywgJ0Z1bmN0aW9uJywgJ1N0cmluZycsICdOdW1iZXInLCAnRGF0ZScsICdSZWdFeHAnXSwgZnVuY3Rpb24obmFtZSkge1xuICAgIF9bJ2lzJyArIG5hbWVdID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgICByZXR1cm4gdG9TdHJpbmcuY2FsbChvYmopID09ICdbb2JqZWN0ICcgKyBuYW1lICsgJ10nO1xuICAgIH07XG4gIH0pO1xuXG4gIC8vIERlZmluZSBhIGZhbGxiYWNrIHZlcnNpb24gb2YgdGhlIG1ldGhvZCBpbiBicm93c2VycyAoYWhlbSwgSUUpLCB3aGVyZVxuICAvLyB0aGVyZSBpc24ndCBhbnkgaW5zcGVjdGFibGUgXCJBcmd1bWVudHNcIiB0eXBlLlxuICBpZiAoIV8uaXNBcmd1bWVudHMoYXJndW1lbnRzKSkge1xuICAgIF8uaXNBcmd1bWVudHMgPSBmdW5jdGlvbihvYmopIHtcbiAgICAgIHJldHVybiAhIShvYmogJiYgXy5oYXMob2JqLCAnY2FsbGVlJykpO1xuICAgIH07XG4gIH1cblxuICAvLyBPcHRpbWl6ZSBgaXNGdW5jdGlvbmAgaWYgYXBwcm9wcmlhdGUuXG4gIGlmICh0eXBlb2YgKC8uLykgIT09ICdmdW5jdGlvbicpIHtcbiAgICBfLmlzRnVuY3Rpb24gPSBmdW5jdGlvbihvYmopIHtcbiAgICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSAnZnVuY3Rpb24nO1xuICAgIH07XG4gIH1cblxuICAvLyBJcyBhIGdpdmVuIG9iamVjdCBhIGZpbml0ZSBudW1iZXI/XG4gIF8uaXNGaW5pdGUgPSBmdW5jdGlvbihvYmopIHtcbiAgICByZXR1cm4gaXNGaW5pdGUob2JqKSAmJiAhaXNOYU4ocGFyc2VGbG9hdChvYmopKTtcbiAgfTtcblxuICAvLyBJcyB0aGUgZ2l2ZW4gdmFsdWUgYE5hTmA/IChOYU4gaXMgdGhlIG9ubHkgbnVtYmVyIHdoaWNoIGRvZXMgbm90IGVxdWFsIGl0c2VsZikuXG4gIF8uaXNOYU4gPSBmdW5jdGlvbihvYmopIHtcbiAgICByZXR1cm4gXy5pc051bWJlcihvYmopICYmIG9iaiAhPSArb2JqO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gdmFsdWUgYSBib29sZWFuP1xuICBfLmlzQm9vbGVhbiA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBvYmogPT09IHRydWUgfHwgb2JqID09PSBmYWxzZSB8fCB0b1N0cmluZy5jYWxsKG9iaikgPT0gJ1tvYmplY3QgQm9vbGVhbl0nO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gdmFsdWUgZXF1YWwgdG8gbnVsbD9cbiAgXy5pc051bGwgPSBmdW5jdGlvbihvYmopIHtcbiAgICByZXR1cm4gb2JqID09PSBudWxsO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gdmFyaWFibGUgdW5kZWZpbmVkP1xuICBfLmlzVW5kZWZpbmVkID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuIG9iaiA9PT0gdm9pZCAwO1xuICB9O1xuXG4gIC8vIFNob3J0Y3V0IGZ1bmN0aW9uIGZvciBjaGVja2luZyBpZiBhbiBvYmplY3QgaGFzIGEgZ2l2ZW4gcHJvcGVydHkgZGlyZWN0bHlcbiAgLy8gb24gaXRzZWxmIChpbiBvdGhlciB3b3Jkcywgbm90IG9uIGEgcHJvdG90eXBlKS5cbiAgXy5oYXMgPSBmdW5jdGlvbihvYmosIGtleSkge1xuICAgIHJldHVybiBoYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwga2V5KTtcbiAgfTtcblxuICAvLyBVdGlsaXR5IEZ1bmN0aW9uc1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8vIFJ1biBVbmRlcnNjb3JlLmpzIGluICpub0NvbmZsaWN0KiBtb2RlLCByZXR1cm5pbmcgdGhlIGBfYCB2YXJpYWJsZSB0byBpdHNcbiAgLy8gcHJldmlvdXMgb3duZXIuIFJldHVybnMgYSByZWZlcmVuY2UgdG8gdGhlIFVuZGVyc2NvcmUgb2JqZWN0LlxuICBfLm5vQ29uZmxpY3QgPSBmdW5jdGlvbigpIHtcbiAgICByb290Ll8gPSBwcmV2aW91c1VuZGVyc2NvcmU7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH07XG5cbiAgLy8gS2VlcCB0aGUgaWRlbnRpdHkgZnVuY3Rpb24gYXJvdW5kIGZvciBkZWZhdWx0IGl0ZXJhdG9ycy5cbiAgXy5pZGVudGl0eSA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9O1xuXG4gIC8vIFJ1biBhIGZ1bmN0aW9uICoqbioqIHRpbWVzLlxuICBfLnRpbWVzID0gZnVuY3Rpb24obiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICB2YXIgYWNjdW0gPSBBcnJheShNYXRoLm1heCgwLCBuKSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyBpKyspIGFjY3VtW2ldID0gaXRlcmF0b3IuY2FsbChjb250ZXh0LCBpKTtcbiAgICByZXR1cm4gYWNjdW07XG4gIH07XG5cbiAgLy8gUmV0dXJuIGEgcmFuZG9tIGludGVnZXIgYmV0d2VlbiBtaW4gYW5kIG1heCAoaW5jbHVzaXZlKS5cbiAgXy5yYW5kb20gPSBmdW5jdGlvbihtaW4sIG1heCkge1xuICAgIGlmIChtYXggPT0gbnVsbCkge1xuICAgICAgbWF4ID0gbWluO1xuICAgICAgbWluID0gMDtcbiAgICB9XG4gICAgcmV0dXJuIG1pbiArIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChtYXggLSBtaW4gKyAxKSk7XG4gIH07XG5cbiAgLy8gTGlzdCBvZiBIVE1MIGVudGl0aWVzIGZvciBlc2NhcGluZy5cbiAgdmFyIGVudGl0eU1hcCA9IHtcbiAgICBlc2NhcGU6IHtcbiAgICAgICcmJzogJyZhbXA7JyxcbiAgICAgICc8JzogJyZsdDsnLFxuICAgICAgJz4nOiAnJmd0OycsXG4gICAgICAnXCInOiAnJnF1b3Q7JyxcbiAgICAgIFwiJ1wiOiAnJiN4Mjc7J1xuICAgIH1cbiAgfTtcbiAgZW50aXR5TWFwLnVuZXNjYXBlID0gXy5pbnZlcnQoZW50aXR5TWFwLmVzY2FwZSk7XG5cbiAgLy8gUmVnZXhlcyBjb250YWluaW5nIHRoZSBrZXlzIGFuZCB2YWx1ZXMgbGlzdGVkIGltbWVkaWF0ZWx5IGFib3ZlLlxuICB2YXIgZW50aXR5UmVnZXhlcyA9IHtcbiAgICBlc2NhcGU6ICAgbmV3IFJlZ0V4cCgnWycgKyBfLmtleXMoZW50aXR5TWFwLmVzY2FwZSkuam9pbignJykgKyAnXScsICdnJyksXG4gICAgdW5lc2NhcGU6IG5ldyBSZWdFeHAoJygnICsgXy5rZXlzKGVudGl0eU1hcC51bmVzY2FwZSkuam9pbignfCcpICsgJyknLCAnZycpXG4gIH07XG5cbiAgLy8gRnVuY3Rpb25zIGZvciBlc2NhcGluZyBhbmQgdW5lc2NhcGluZyBzdHJpbmdzIHRvL2Zyb20gSFRNTCBpbnRlcnBvbGF0aW9uLlxuICBfLmVhY2goWydlc2NhcGUnLCAndW5lc2NhcGUnXSwgZnVuY3Rpb24obWV0aG9kKSB7XG4gICAgX1ttZXRob2RdID0gZnVuY3Rpb24oc3RyaW5nKSB7XG4gICAgICBpZiAoc3RyaW5nID09IG51bGwpIHJldHVybiAnJztcbiAgICAgIHJldHVybiAoJycgKyBzdHJpbmcpLnJlcGxhY2UoZW50aXR5UmVnZXhlc1ttZXRob2RdLCBmdW5jdGlvbihtYXRjaCkge1xuICAgICAgICByZXR1cm4gZW50aXR5TWFwW21ldGhvZF1bbWF0Y2hdO1xuICAgICAgfSk7XG4gICAgfTtcbiAgfSk7XG5cbiAgLy8gSWYgdGhlIHZhbHVlIG9mIHRoZSBuYW1lZCBgcHJvcGVydHlgIGlzIGEgZnVuY3Rpb24gdGhlbiBpbnZva2UgaXQgd2l0aCB0aGVcbiAgLy8gYG9iamVjdGAgYXMgY29udGV4dDsgb3RoZXJ3aXNlLCByZXR1cm4gaXQuXG4gIF8ucmVzdWx0ID0gZnVuY3Rpb24ob2JqZWN0LCBwcm9wZXJ0eSkge1xuICAgIGlmIChvYmplY3QgPT0gbnVsbCkgcmV0dXJuIHZvaWQgMDtcbiAgICB2YXIgdmFsdWUgPSBvYmplY3RbcHJvcGVydHldO1xuICAgIHJldHVybiBfLmlzRnVuY3Rpb24odmFsdWUpID8gdmFsdWUuY2FsbChvYmplY3QpIDogdmFsdWU7XG4gIH07XG5cbiAgLy8gQWRkIHlvdXIgb3duIGN1c3RvbSBmdW5jdGlvbnMgdG8gdGhlIFVuZGVyc2NvcmUgb2JqZWN0LlxuICBfLm1peGluID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgZWFjaChfLmZ1bmN0aW9ucyhvYmopLCBmdW5jdGlvbihuYW1lKSB7XG4gICAgICB2YXIgZnVuYyA9IF9bbmFtZV0gPSBvYmpbbmFtZV07XG4gICAgICBfLnByb3RvdHlwZVtuYW1lXSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgYXJncyA9IFt0aGlzLl93cmFwcGVkXTtcbiAgICAgICAgcHVzaC5hcHBseShhcmdzLCBhcmd1bWVudHMpO1xuICAgICAgICByZXR1cm4gcmVzdWx0LmNhbGwodGhpcywgZnVuYy5hcHBseShfLCBhcmdzKSk7XG4gICAgICB9O1xuICAgIH0pO1xuICB9O1xuXG4gIC8vIEdlbmVyYXRlIGEgdW5pcXVlIGludGVnZXIgaWQgKHVuaXF1ZSB3aXRoaW4gdGhlIGVudGlyZSBjbGllbnQgc2Vzc2lvbikuXG4gIC8vIFVzZWZ1bCBmb3IgdGVtcG9yYXJ5IERPTSBpZHMuXG4gIHZhciBpZENvdW50ZXIgPSAwO1xuICBfLnVuaXF1ZUlkID0gZnVuY3Rpb24ocHJlZml4KSB7XG4gICAgdmFyIGlkID0gKytpZENvdW50ZXIgKyAnJztcbiAgICByZXR1cm4gcHJlZml4ID8gcHJlZml4ICsgaWQgOiBpZDtcbiAgfTtcblxuICAvLyBCeSBkZWZhdWx0LCBVbmRlcnNjb3JlIHVzZXMgRVJCLXN0eWxlIHRlbXBsYXRlIGRlbGltaXRlcnMsIGNoYW5nZSB0aGVcbiAgLy8gZm9sbG93aW5nIHRlbXBsYXRlIHNldHRpbmdzIHRvIHVzZSBhbHRlcm5hdGl2ZSBkZWxpbWl0ZXJzLlxuICBfLnRlbXBsYXRlU2V0dGluZ3MgPSB7XG4gICAgZXZhbHVhdGUgICAgOiAvPCUoW1xcc1xcU10rPyklPi9nLFxuICAgIGludGVycG9sYXRlIDogLzwlPShbXFxzXFxTXSs/KSU+L2csXG4gICAgZXNjYXBlICAgICAgOiAvPCUtKFtcXHNcXFNdKz8pJT4vZ1xuICB9O1xuXG4gIC8vIFdoZW4gY3VzdG9taXppbmcgYHRlbXBsYXRlU2V0dGluZ3NgLCBpZiB5b3UgZG9uJ3Qgd2FudCB0byBkZWZpbmUgYW5cbiAgLy8gaW50ZXJwb2xhdGlvbiwgZXZhbHVhdGlvbiBvciBlc2NhcGluZyByZWdleCwgd2UgbmVlZCBvbmUgdGhhdCBpc1xuICAvLyBndWFyYW50ZWVkIG5vdCB0byBtYXRjaC5cbiAgdmFyIG5vTWF0Y2ggPSAvKC4pXi87XG5cbiAgLy8gQ2VydGFpbiBjaGFyYWN0ZXJzIG5lZWQgdG8gYmUgZXNjYXBlZCBzbyB0aGF0IHRoZXkgY2FuIGJlIHB1dCBpbnRvIGFcbiAgLy8gc3RyaW5nIGxpdGVyYWwuXG4gIHZhciBlc2NhcGVzID0ge1xuICAgIFwiJ1wiOiAgICAgIFwiJ1wiLFxuICAgICdcXFxcJzogICAgICdcXFxcJyxcbiAgICAnXFxyJzogICAgICdyJyxcbiAgICAnXFxuJzogICAgICduJyxcbiAgICAnXFx0JzogICAgICd0JyxcbiAgICAnXFx1MjAyOCc6ICd1MjAyOCcsXG4gICAgJ1xcdTIwMjknOiAndTIwMjknXG4gIH07XG5cbiAgdmFyIGVzY2FwZXIgPSAvXFxcXHwnfFxccnxcXG58XFx0fFxcdTIwMjh8XFx1MjAyOS9nO1xuXG4gIC8vIEphdmFTY3JpcHQgbWljcm8tdGVtcGxhdGluZywgc2ltaWxhciB0byBKb2huIFJlc2lnJ3MgaW1wbGVtZW50YXRpb24uXG4gIC8vIFVuZGVyc2NvcmUgdGVtcGxhdGluZyBoYW5kbGVzIGFyYml0cmFyeSBkZWxpbWl0ZXJzLCBwcmVzZXJ2ZXMgd2hpdGVzcGFjZSxcbiAgLy8gYW5kIGNvcnJlY3RseSBlc2NhcGVzIHF1b3RlcyB3aXRoaW4gaW50ZXJwb2xhdGVkIGNvZGUuXG4gIF8udGVtcGxhdGUgPSBmdW5jdGlvbih0ZXh0LCBkYXRhLCBzZXR0aW5ncykge1xuICAgIHZhciByZW5kZXI7XG4gICAgc2V0dGluZ3MgPSBfLmRlZmF1bHRzKHt9LCBzZXR0aW5ncywgXy50ZW1wbGF0ZVNldHRpbmdzKTtcblxuICAgIC8vIENvbWJpbmUgZGVsaW1pdGVycyBpbnRvIG9uZSByZWd1bGFyIGV4cHJlc3Npb24gdmlhIGFsdGVybmF0aW9uLlxuICAgIHZhciBtYXRjaGVyID0gbmV3IFJlZ0V4cChbXG4gICAgICAoc2V0dGluZ3MuZXNjYXBlIHx8IG5vTWF0Y2gpLnNvdXJjZSxcbiAgICAgIChzZXR0aW5ncy5pbnRlcnBvbGF0ZSB8fCBub01hdGNoKS5zb3VyY2UsXG4gICAgICAoc2V0dGluZ3MuZXZhbHVhdGUgfHwgbm9NYXRjaCkuc291cmNlXG4gICAgXS5qb2luKCd8JykgKyAnfCQnLCAnZycpO1xuXG4gICAgLy8gQ29tcGlsZSB0aGUgdGVtcGxhdGUgc291cmNlLCBlc2NhcGluZyBzdHJpbmcgbGl0ZXJhbHMgYXBwcm9wcmlhdGVseS5cbiAgICB2YXIgaW5kZXggPSAwO1xuICAgIHZhciBzb3VyY2UgPSBcIl9fcCs9J1wiO1xuICAgIHRleHQucmVwbGFjZShtYXRjaGVyLCBmdW5jdGlvbihtYXRjaCwgZXNjYXBlLCBpbnRlcnBvbGF0ZSwgZXZhbHVhdGUsIG9mZnNldCkge1xuICAgICAgc291cmNlICs9IHRleHQuc2xpY2UoaW5kZXgsIG9mZnNldClcbiAgICAgICAgLnJlcGxhY2UoZXNjYXBlciwgZnVuY3Rpb24obWF0Y2gpIHsgcmV0dXJuICdcXFxcJyArIGVzY2FwZXNbbWF0Y2hdOyB9KTtcblxuICAgICAgaWYgKGVzY2FwZSkge1xuICAgICAgICBzb3VyY2UgKz0gXCInK1xcbigoX190PShcIiArIGVzY2FwZSArIFwiKSk9PW51bGw/Jyc6Xy5lc2NhcGUoX190KSkrXFxuJ1wiO1xuICAgICAgfVxuICAgICAgaWYgKGludGVycG9sYXRlKSB7XG4gICAgICAgIHNvdXJjZSArPSBcIicrXFxuKChfX3Q9KFwiICsgaW50ZXJwb2xhdGUgKyBcIikpPT1udWxsPycnOl9fdCkrXFxuJ1wiO1xuICAgICAgfVxuICAgICAgaWYgKGV2YWx1YXRlKSB7XG4gICAgICAgIHNvdXJjZSArPSBcIic7XFxuXCIgKyBldmFsdWF0ZSArIFwiXFxuX19wKz0nXCI7XG4gICAgICB9XG4gICAgICBpbmRleCA9IG9mZnNldCArIG1hdGNoLmxlbmd0aDtcbiAgICAgIHJldHVybiBtYXRjaDtcbiAgICB9KTtcbiAgICBzb3VyY2UgKz0gXCInO1xcblwiO1xuXG4gICAgLy8gSWYgYSB2YXJpYWJsZSBpcyBub3Qgc3BlY2lmaWVkLCBwbGFjZSBkYXRhIHZhbHVlcyBpbiBsb2NhbCBzY29wZS5cbiAgICBpZiAoIXNldHRpbmdzLnZhcmlhYmxlKSBzb3VyY2UgPSAnd2l0aChvYmp8fHt9KXtcXG4nICsgc291cmNlICsgJ31cXG4nO1xuXG4gICAgc291cmNlID0gXCJ2YXIgX190LF9fcD0nJyxfX2o9QXJyYXkucHJvdG90eXBlLmpvaW4sXCIgK1xuICAgICAgXCJwcmludD1mdW5jdGlvbigpe19fcCs9X19qLmNhbGwoYXJndW1lbnRzLCcnKTt9O1xcblwiICtcbiAgICAgIHNvdXJjZSArIFwicmV0dXJuIF9fcDtcXG5cIjtcblxuICAgIHRyeSB7XG4gICAgICByZW5kZXIgPSBuZXcgRnVuY3Rpb24oc2V0dGluZ3MudmFyaWFibGUgfHwgJ29iaicsICdfJywgc291cmNlKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBlLnNvdXJjZSA9IHNvdXJjZTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuXG4gICAgaWYgKGRhdGEpIHJldHVybiByZW5kZXIoZGF0YSwgXyk7XG4gICAgdmFyIHRlbXBsYXRlID0gZnVuY3Rpb24oZGF0YSkge1xuICAgICAgcmV0dXJuIHJlbmRlci5jYWxsKHRoaXMsIGRhdGEsIF8pO1xuICAgIH07XG5cbiAgICAvLyBQcm92aWRlIHRoZSBjb21waWxlZCBmdW5jdGlvbiBzb3VyY2UgYXMgYSBjb252ZW5pZW5jZSBmb3IgcHJlY29tcGlsYXRpb24uXG4gICAgdGVtcGxhdGUuc291cmNlID0gJ2Z1bmN0aW9uKCcgKyAoc2V0dGluZ3MudmFyaWFibGUgfHwgJ29iaicpICsgJyl7XFxuJyArIHNvdXJjZSArICd9JztcblxuICAgIHJldHVybiB0ZW1wbGF0ZTtcbiAgfTtcblxuICAvLyBBZGQgYSBcImNoYWluXCIgZnVuY3Rpb24sIHdoaWNoIHdpbGwgZGVsZWdhdGUgdG8gdGhlIHdyYXBwZXIuXG4gIF8uY2hhaW4gPSBmdW5jdGlvbihvYmopIHtcbiAgICByZXR1cm4gXyhvYmopLmNoYWluKCk7XG4gIH07XG5cbiAgLy8gT09QXG4gIC8vIC0tLS0tLS0tLS0tLS0tLVxuICAvLyBJZiBVbmRlcnNjb3JlIGlzIGNhbGxlZCBhcyBhIGZ1bmN0aW9uLCBpdCByZXR1cm5zIGEgd3JhcHBlZCBvYmplY3QgdGhhdFxuICAvLyBjYW4gYmUgdXNlZCBPTy1zdHlsZS4gVGhpcyB3cmFwcGVyIGhvbGRzIGFsdGVyZWQgdmVyc2lvbnMgb2YgYWxsIHRoZVxuICAvLyB1bmRlcnNjb3JlIGZ1bmN0aW9ucy4gV3JhcHBlZCBvYmplY3RzIG1heSBiZSBjaGFpbmVkLlxuXG4gIC8vIEhlbHBlciBmdW5jdGlvbiB0byBjb250aW51ZSBjaGFpbmluZyBpbnRlcm1lZGlhdGUgcmVzdWx0cy5cbiAgdmFyIHJlc3VsdCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiB0aGlzLl9jaGFpbiA/IF8ob2JqKS5jaGFpbigpIDogb2JqO1xuICB9O1xuXG4gIC8vIEFkZCBhbGwgb2YgdGhlIFVuZGVyc2NvcmUgZnVuY3Rpb25zIHRvIHRoZSB3cmFwcGVyIG9iamVjdC5cbiAgXy5taXhpbihfKTtcblxuICAvLyBBZGQgYWxsIG11dGF0b3IgQXJyYXkgZnVuY3Rpb25zIHRvIHRoZSB3cmFwcGVyLlxuICBlYWNoKFsncG9wJywgJ3B1c2gnLCAncmV2ZXJzZScsICdzaGlmdCcsICdzb3J0JywgJ3NwbGljZScsICd1bnNoaWZ0J10sIGZ1bmN0aW9uKG5hbWUpIHtcbiAgICB2YXIgbWV0aG9kID0gQXJyYXlQcm90b1tuYW1lXTtcbiAgICBfLnByb3RvdHlwZVtuYW1lXSA9IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIG9iaiA9IHRoaXMuX3dyYXBwZWQ7XG4gICAgICBtZXRob2QuYXBwbHkob2JqLCBhcmd1bWVudHMpO1xuICAgICAgaWYgKChuYW1lID09ICdzaGlmdCcgfHwgbmFtZSA9PSAnc3BsaWNlJykgJiYgb2JqLmxlbmd0aCA9PT0gMCkgZGVsZXRlIG9ialswXTtcbiAgICAgIHJldHVybiByZXN1bHQuY2FsbCh0aGlzLCBvYmopO1xuICAgIH07XG4gIH0pO1xuXG4gIC8vIEFkZCBhbGwgYWNjZXNzb3IgQXJyYXkgZnVuY3Rpb25zIHRvIHRoZSB3cmFwcGVyLlxuICBlYWNoKFsnY29uY2F0JywgJ2pvaW4nLCAnc2xpY2UnXSwgZnVuY3Rpb24obmFtZSkge1xuICAgIHZhciBtZXRob2QgPSBBcnJheVByb3RvW25hbWVdO1xuICAgIF8ucHJvdG90eXBlW25hbWVdID0gZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gcmVzdWx0LmNhbGwodGhpcywgbWV0aG9kLmFwcGx5KHRoaXMuX3dyYXBwZWQsIGFyZ3VtZW50cykpO1xuICAgIH07XG4gIH0pO1xuXG4gIF8uZXh0ZW5kKF8ucHJvdG90eXBlLCB7XG5cbiAgICAvLyBTdGFydCBjaGFpbmluZyBhIHdyYXBwZWQgVW5kZXJzY29yZSBvYmplY3QuXG4gICAgY2hhaW46IGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5fY2hhaW4gPSB0cnVlO1xuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSxcblxuICAgIC8vIEV4dHJhY3RzIHRoZSByZXN1bHQgZnJvbSBhIHdyYXBwZWQgYW5kIGNoYWluZWQgb2JqZWN0LlxuICAgIHZhbHVlOiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiB0aGlzLl93cmFwcGVkO1xuICAgIH1cblxuICB9KTtcblxufSkuY2FsbCh0aGlzKTtcbiIsIi8vIGNyZWF0ZWQgYnkgQEhlbnJpa0pvcmV0ZWdcbnZhciBwcmVmaXg7XG52YXIgaXNDaHJvbWUgPSBmYWxzZTtcbnZhciBpc0ZpcmVmb3ggPSBmYWxzZTtcbnZhciB1YSA9IG5hdmlnYXRvci51c2VyQWdlbnQudG9Mb3dlckNhc2UoKTtcblxuLy8gYmFzaWMgc25pZmZpbmdcbmlmICh1YS5pbmRleE9mKCdmaXJlZm94JykgIT09IC0xKSB7XG4gICAgcHJlZml4ID0gJ21veic7XG4gICAgaXNGaXJlZm94ID0gdHJ1ZTtcbn0gZWxzZSBpZiAodWEuaW5kZXhPZignY2hyb21lJykgIT09IC0xKSB7XG4gICAgcHJlZml4ID0gJ3dlYmtpdCc7XG4gICAgaXNDaHJvbWUgPSB0cnVlO1xufVxuXG52YXIgUEMgPSB3aW5kb3cubW96UlRDUGVlckNvbm5lY3Rpb24gfHwgd2luZG93LndlYmtpdFJUQ1BlZXJDb25uZWN0aW9uO1xudmFyIEljZUNhbmRpZGF0ZSA9IHdpbmRvdy5tb3pSVENJY2VDYW5kaWRhdGUgfHwgd2luZG93LlJUQ0ljZUNhbmRpZGF0ZTtcbnZhciBTZXNzaW9uRGVzY3JpcHRpb24gPSB3aW5kb3cubW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8IHdpbmRvdy5SVENTZXNzaW9uRGVzY3JpcHRpb247XG52YXIgTWVkaWFTdHJlYW0gPSB3aW5kb3cud2Via2l0TWVkaWFTdHJlYW0gfHwgd2luZG93Lk1lZGlhU3RyZWFtO1xudmFyIHNjcmVlblNoYXJpbmcgPSBuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKCdDaHJvbWUnKSAmJiBwYXJzZUludChuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKC9DaHJvbWVcXC8oLiopIC8pWzFdLCAxMCkgPj0gMjY7XG52YXIgQXVkaW9Db250ZXh0ID0gd2luZG93LndlYmtpdEF1ZGlvQ29udGV4dCB8fCB3aW5kb3cuQXVkaW9Db250ZXh0O1xuXG5cbi8vIGV4cG9ydCBzdXBwb3J0IGZsYWdzIGFuZCBjb25zdHJ1Y3RvcnMucHJvdG90eXBlICYmIFBDXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBzdXBwb3J0OiAhIVBDLFxuICAgIGRhdGFDaGFubmVsOiBpc0Nocm9tZSB8fCBpc0ZpcmVmb3ggfHwgKFBDLnByb3RvdHlwZSAmJiBQQy5wcm90b3R5cGUuY3JlYXRlRGF0YUNoYW5uZWwpLFxuICAgIHByZWZpeDogcHJlZml4LFxuICAgIHdlYkF1ZGlvOiAhIShBdWRpb0NvbnRleHQgJiYgQXVkaW9Db250ZXh0LnByb3RvdHlwZS5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZSksXG4gICAgbWVkaWFTdHJlYW06ICEhKE1lZGlhU3RyZWFtICYmIE1lZGlhU3RyZWFtLnByb3RvdHlwZS5yZW1vdmVUcmFjayksXG4gICAgc2NyZWVuU2hhcmluZzogISFzY3JlZW5TaGFyaW5nLFxuICAgIEF1ZGlvQ29udGV4dDogQXVkaW9Db250ZXh0LFxuICAgIFBlZXJDb25uZWN0aW9uOiBQQyxcbiAgICBTZXNzaW9uRGVzY3JpcHRpb246IFNlc3Npb25EZXNjcmlwdGlvbixcbiAgICBJY2VDYW5kaWRhdGU6IEljZUNhbmRpZGF0ZVxufTtcbiIsIi8qXG5XaWxkRW1pdHRlci5qcyBpcyBhIHNsaW0gbGl0dGxlIGV2ZW50IGVtaXR0ZXIgYnkgQGhlbnJpa2pvcmV0ZWcgbGFyZ2VseSBiYXNlZCBcbm9uIEB2aXNpb25tZWRpYSdzIEVtaXR0ZXIgZnJvbSBVSSBLaXQuXG5cbldoeT8gSSB3YW50ZWQgaXQgc3RhbmRhbG9uZS5cblxuSSBhbHNvIHdhbnRlZCBzdXBwb3J0IGZvciB3aWxkY2FyZCBlbWl0dGVycyBsaWtlIHRoaXM6XG5cbmVtaXR0ZXIub24oJyonLCBmdW5jdGlvbiAoZXZlbnROYW1lLCBvdGhlciwgZXZlbnQsIHBheWxvYWRzKSB7XG4gICAgXG59KTtcblxuZW1pdHRlci5vbignc29tZW5hbWVzcGFjZSonLCBmdW5jdGlvbiAoZXZlbnROYW1lLCBwYXlsb2Fkcykge1xuICAgIFxufSk7XG5cblBsZWFzZSBub3RlIHRoYXQgY2FsbGJhY2tzIHRyaWdnZXJlZCBieSB3aWxkY2FyZCByZWdpc3RlcmVkIGV2ZW50cyBhbHNvIGdldCBcbnRoZSBldmVudCBuYW1lIGFzIHRoZSBmaXJzdCBhcmd1bWVudC5cbiovXG5tb2R1bGUuZXhwb3J0cyA9IFdpbGRFbWl0dGVyO1xuXG5mdW5jdGlvbiBXaWxkRW1pdHRlcigpIHtcbiAgICB0aGlzLmNhbGxiYWNrcyA9IHt9O1xufVxuXG4vLyBMaXN0ZW4gb24gdGhlIGdpdmVuIGBldmVudGAgd2l0aCBgZm5gLiBTdG9yZSBhIGdyb3VwIG5hbWUgaWYgcHJlc2VudC5cbldpbGRFbWl0dGVyLnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uIChldmVudCwgZ3JvdXBOYW1lLCBmbikge1xuICAgIHZhciBoYXNHcm91cCA9IChhcmd1bWVudHMubGVuZ3RoID09PSAzKSxcbiAgICAgICAgZ3JvdXAgPSBoYXNHcm91cCA/IGFyZ3VtZW50c1sxXSA6IHVuZGVmaW5lZCwgXG4gICAgICAgIGZ1bmMgPSBoYXNHcm91cCA/IGFyZ3VtZW50c1syXSA6IGFyZ3VtZW50c1sxXTtcbiAgICBmdW5jLl9ncm91cE5hbWUgPSBncm91cDtcbiAgICAodGhpcy5jYWxsYmFja3NbZXZlbnRdID0gdGhpcy5jYWxsYmFja3NbZXZlbnRdIHx8IFtdKS5wdXNoKGZ1bmMpO1xuICAgIHJldHVybiB0aGlzO1xufTtcblxuLy8gQWRkcyBhbiBgZXZlbnRgIGxpc3RlbmVyIHRoYXQgd2lsbCBiZSBpbnZva2VkIGEgc2luZ2xlXG4vLyB0aW1lIHRoZW4gYXV0b21hdGljYWxseSByZW1vdmVkLlxuV2lsZEVtaXR0ZXIucHJvdG90eXBlLm9uY2UgPSBmdW5jdGlvbiAoZXZlbnQsIGdyb3VwTmFtZSwgZm4pIHtcbiAgICB2YXIgc2VsZiA9IHRoaXMsXG4gICAgICAgIGhhc0dyb3VwID0gKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpLFxuICAgICAgICBncm91cCA9IGhhc0dyb3VwID8gYXJndW1lbnRzWzFdIDogdW5kZWZpbmVkLCBcbiAgICAgICAgZnVuYyA9IGhhc0dyb3VwID8gYXJndW1lbnRzWzJdIDogYXJndW1lbnRzWzFdO1xuICAgIGZ1bmN0aW9uIG9uKCkge1xuICAgICAgICBzZWxmLm9mZihldmVudCwgb24pO1xuICAgICAgICBmdW5jLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuICAgIHRoaXMub24oZXZlbnQsIGdyb3VwLCBvbik7XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBVbmJpbmRzIGFuIGVudGlyZSBncm91cFxuV2lsZEVtaXR0ZXIucHJvdG90eXBlLnJlbGVhc2VHcm91cCA9IGZ1bmN0aW9uIChncm91cE5hbWUpIHtcbiAgICB2YXIgaXRlbSwgaSwgbGVuLCBoYW5kbGVycztcbiAgICBmb3IgKGl0ZW0gaW4gdGhpcy5jYWxsYmFja3MpIHtcbiAgICAgICAgaGFuZGxlcnMgPSB0aGlzLmNhbGxiYWNrc1tpdGVtXTtcbiAgICAgICAgZm9yIChpID0gMCwgbGVuID0gaGFuZGxlcnMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgICAgICAgIGlmIChoYW5kbGVyc1tpXS5fZ3JvdXBOYW1lID09PSBncm91cE5hbWUpIHtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUubG9nKCdyZW1vdmluZycpO1xuICAgICAgICAgICAgICAgIC8vIHJlbW92ZSBpdCBhbmQgc2hvcnRlbiB0aGUgYXJyYXkgd2UncmUgbG9vcGluZyB0aHJvdWdoXG4gICAgICAgICAgICAgICAgaGFuZGxlcnMuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgICAgIGktLTtcbiAgICAgICAgICAgICAgICBsZW4tLTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbn07XG5cbi8vIFJlbW92ZSB0aGUgZ2l2ZW4gY2FsbGJhY2sgZm9yIGBldmVudGAgb3IgYWxsXG4vLyByZWdpc3RlcmVkIGNhbGxiYWNrcy5cbldpbGRFbWl0dGVyLnByb3RvdHlwZS5vZmYgPSBmdW5jdGlvbiAoZXZlbnQsIGZuKSB7XG4gICAgdmFyIGNhbGxiYWNrcyA9IHRoaXMuY2FsbGJhY2tzW2V2ZW50XSxcbiAgICAgICAgaTtcbiAgICBcbiAgICBpZiAoIWNhbGxiYWNrcykgcmV0dXJuIHRoaXM7XG5cbiAgICAvLyByZW1vdmUgYWxsIGhhbmRsZXJzXG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgZGVsZXRlIHRoaXMuY2FsbGJhY2tzW2V2ZW50XTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgLy8gcmVtb3ZlIHNwZWNpZmljIGhhbmRsZXJcbiAgICBpID0gY2FsbGJhY2tzLmluZGV4T2YoZm4pO1xuICAgIGNhbGxiYWNrcy5zcGxpY2UoaSwgMSk7XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBFbWl0IGBldmVudGAgd2l0aCB0aGUgZ2l2ZW4gYXJncy5cbi8vIGFsc28gY2FsbHMgYW55IGAqYCBoYW5kbGVyc1xuV2lsZEVtaXR0ZXIucHJvdG90eXBlLmVtaXQgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSxcbiAgICAgICAgY2FsbGJhY2tzID0gdGhpcy5jYWxsYmFja3NbZXZlbnRdLFxuICAgICAgICBzcGVjaWFsQ2FsbGJhY2tzID0gdGhpcy5nZXRXaWxkY2FyZENhbGxiYWNrcyhldmVudCksXG4gICAgICAgIGksXG4gICAgICAgIGxlbixcbiAgICAgICAgaXRlbTtcblxuICAgIGlmIChjYWxsYmFja3MpIHtcbiAgICAgICAgZm9yIChpID0gMCwgbGVuID0gY2FsbGJhY2tzLmxlbmd0aDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgICAgICBpZiAoY2FsbGJhY2tzW2ldKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzcGVjaWFsQ2FsbGJhY2tzKSB7XG4gICAgICAgIGZvciAoaSA9IDAsIGxlbiA9IHNwZWNpYWxDYWxsYmFja3MubGVuZ3RoOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgICAgIGlmIChzcGVjaWFsQ2FsbGJhY2tzW2ldKSB7XG4gICAgICAgICAgICAgICAgc3BlY2lhbENhbGxiYWNrc1tpXS5hcHBseSh0aGlzLCBbZXZlbnRdLmNvbmNhdChhcmdzKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBIZWxwZXIgZm9yIGZvciBmaW5kaW5nIHNwZWNpYWwgd2lsZGNhcmQgZXZlbnQgaGFuZGxlcnMgdGhhdCBtYXRjaCB0aGUgZXZlbnRcbldpbGRFbWl0dGVyLnByb3RvdHlwZS5nZXRXaWxkY2FyZENhbGxiYWNrcyA9IGZ1bmN0aW9uIChldmVudE5hbWUpIHtcbiAgICB2YXIgaXRlbSxcbiAgICAgICAgc3BsaXQsXG4gICAgICAgIHJlc3VsdCA9IFtdO1xuXG4gICAgZm9yIChpdGVtIGluIHRoaXMuY2FsbGJhY2tzKSB7XG4gICAgICAgIHNwbGl0ID0gaXRlbS5zcGxpdCgnKicpO1xuICAgICAgICBpZiAoaXRlbSA9PT0gJyonIHx8IChzcGxpdC5sZW5ndGggPT09IDIgJiYgZXZlbnROYW1lLnNsaWNlKDAsIHNwbGl0WzFdLmxlbmd0aCkgPT09IHNwbGl0WzFdKSkge1xuICAgICAgICAgICAgcmVzdWx0ID0gcmVzdWx0LmNvbmNhdCh0aGlzLmNhbGxiYWNrc1tpdGVtXSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG4iXX0=
;