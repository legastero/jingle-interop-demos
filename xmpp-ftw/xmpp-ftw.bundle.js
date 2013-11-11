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
  socket.emit(
    'xmpp.login', {
        jid: jid,
        password: document.getElementById('password').value,
        host: document.getElementById('host').value
    }
  )
  socket.on('xmpp.connection', function(data) {
    console.log('connected', data)
    socket.emit('xmpp.presence', {})
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
    socket.emit('xmpp.jingle.request', data, function(error, success) {
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
            if (ev.source === window && ev.data === 'process-tick') {
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
            self.emit('send', {to: sender, id: reqid, type: 'result'});
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
var JingleJSON = require('sdp-jingle-json');


function JinglePeerConnection(config, constraints) {
    this.sid = '';
    this.sdpSessId = Date.now();
    this.isInitiator = true;

    this.localDescription = {contents: []};
    this.remoteDescription = {contents: []};

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
            var json = JingleJSON.toSessionJSON(offer.sdp, self.isInitiator ? 'initiator' : 'responder');
            json.sid = this.sid;
            self.localDescription = json;
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
    answer.sdp = JingleJSON.toSessionSDP(answer.json, this.sdpSessId);
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
    offer.sdp = JingleJSON.toSessionSDP(offer.json, self.sdpSessId);
    self.remoteDescription = offer.json;
    this.pc.setRemoteDescription(new webrtc.SessionDescription(offer), function () {
        self.pc.createAnswer(
            function (answer) {
                answer.sdp = self._applySdpHack(answer.sdp);
                self.pc.setLocalDescription(answer);
                var json = JingleJSON.toSessionJSON(answer.sdp);
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
            var iceCandidate = JingleJSON.toCandidateSDP(candidate) + '\r\n';
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
        this.emit('ice', {
            contents: [{
                name: ice.sdpMid,
                creator: self.isInitiator ? 'initiator' : 'responder',
                transport: {
                    transType: 'iceUdp',
                    candidates: [
                        JingleJSON.toCandidateJSON(ice.candidate)
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
//@ sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbWFpbi5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvYXR0YWNobWVkaWFzdHJlYW0vYXR0YWNobWVkaWFzdHJlYW0uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2luc2VydC1tb2R1bGUtZ2xvYmFscy9ub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvaW5kZXguanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9saWIvZ2VuZXJpY1Nlc3Npb24uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9saWIvbWVkaWFTZXNzaW9uLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbGliL3Nlc3Npb25NYW5hZ2VyLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL2FzeW5jL2xpYi9hc3luYy5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9ib3dzL2Jvd3MuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvYm93cy9ub2RlX21vZHVsZXMvYW5kbG9nL2FuZGxvZy5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9nZXR1c2VybWVkaWEvZ2V0dXNlcm1lZGlhLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL2hhcmsvaGFyay5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9qaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24vaW5kZXguanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvamluZ2xlLXJ0Y3BlZXJjb25uZWN0aW9uL25vZGVfbW9kdWxlcy9ydGNwZWVyY29ubmVjdGlvbi9ydGNwZWVyY29ubmVjdGlvbi5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9tZWRpYXN0cmVhbS1nYWluL21lZGlhc3RyZWFtLWdhaW4uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvbWVkaWFzdHJlYW0tZ2Fpbi9ub2RlX21vZHVsZXMvd2VicnRjc3VwcG9ydC93ZWJydGNzdXBwb3J0LmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL21vY2tjb25zb2xlL21vY2tjb25zb2xlLmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL3NkcC1qaW5nbGUtanNvbi9pbmRleC5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy9zZHAtamluZ2xlLWpzb24vbGliL3BhcnNlcnMuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvc2RwLWppbmdsZS1qc29uL2xpYi90b2pzb24uanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvc2RwLWppbmdsZS1qc29uL2xpYi90b3NkcC5qcyIsIi9ob21lL2xsb3lkL0Ryb3Bib3gvY29kZS94bXBwLWZ0dy93ZWJydGMtZGVtby9ub2RlX21vZHVsZXMvamluZ2xlL25vZGVfbW9kdWxlcy91bmRlcnNjb3JlL3VuZGVyc2NvcmUuanMiLCIvaG9tZS9sbG95ZC9Ecm9wYm94L2NvZGUveG1wcC1mdHcvd2VicnRjLWRlbW8vbm9kZV9tb2R1bGVzL2ppbmdsZS9ub2RlX21vZHVsZXMvd2VicnRjc3VwcG9ydC93ZWJydGNzdXBwb3J0LmpzIiwiL2hvbWUvbGxveWQvRHJvcGJveC9jb2RlL3htcHAtZnR3L3dlYnJ0Yy1kZW1vL25vZGVfbW9kdWxlcy9qaW5nbGUvbm9kZV9tb2R1bGVzL3dpbGRlbWl0dGVyL3dpbGRlbWl0dGVyLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcERBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzM3QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdktBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNU5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzV2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwic291cmNlc0NvbnRlbnQiOlsidmFyIEppbmdsZSA9IHJlcXVpcmUoJ2ppbmdsZScpXG4gICwgYXR0YWNoTWVkaWFTdHJlYW0gPSByZXF1aXJlKCdhdHRhY2htZWRpYXN0cmVhbScpXG5cbnZhciBzb2NrZXQgPSBuZXcgUHJpbXVzKCdodHRwczovL3htcHAtZnR3LmppdC5zdScpXG52YXIgamluZ2xlID0gbmV3IEppbmdsZSgpXG5cbnZhciBsb2dpbkluZm8gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9naW5JbmZvJylcbnZhciBsb2NhbFN0YXJ0ZWQgPSBmYWxzZVxuXG5sb2dpbkluZm8ub25zdWJtaXQgPSBmdW5jdGlvbiAoZSkge1xuICBpZiAoZS5wcmV2ZW50RGVmYXVsdCkgZS5wcmV2ZW50RGVmYXVsdCgpXG5cbiAgdmFyIGppZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqaWQnKS52YWx1ZVxuICB2YXIgdXNlcm5hbWUgPSBqaWQuc2xpY2UoMCwgamlkLmluZGV4T2YoJ0AnKSlcblxuICBjb25zb2xlLmxvZygnQ29ubmVjdGVkJylcbiAgc29ja2V0LmVtaXQoXG4gICAgJ3htcHAubG9naW4nLCB7XG4gICAgICAgIGppZDogamlkLFxuICAgICAgICBwYXNzd29yZDogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Bhc3N3b3JkJykudmFsdWUsXG4gICAgICAgIGhvc3Q6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdob3N0JykudmFsdWVcbiAgICB9XG4gIClcbiAgc29ja2V0Lm9uKCd4bXBwLmNvbm5lY3Rpb24nLCBmdW5jdGlvbihkYXRhKSB7XG4gICAgY29uc29sZS5sb2coJ2Nvbm5lY3RlZCcsIGRhdGEpXG4gICAgc29ja2V0LmVtaXQoJ3htcHAucHJlc2VuY2UnLCB7fSlcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXlKSUQnKS50ZXh0Q29udGVudCA9IGRhdGEuamlkLnVzZXIgK1xuICAgICAgICAnQCcgKyBkYXRhLmppZC5kb21haW4gKyAnLycgKyBkYXRhLmppZC5yZXNvdXJjZVxuICB9KVxuXG4gIGppbmdsZS5vbignaW5jb21pbmcnLCBmdW5jdGlvbiAoc2Vzc2lvbikge1xuICAgIGNvbnNvbGUubG9nKCdpbmNvbWluZyBzZXNzaW9uJywgc2Vzc2lvbilcbiAgICBzZXNzaW9uLmFjY2VwdCgpXG4gIH0pXG4gIGppbmdsZS5vbigncGVlclN0cmVhbUFkZGVkJywgZnVuY3Rpb24oc2Vzc2lvbikge1xuICAgIGNvbnNvbGUubG9nKCdwZWVyU3RyZWFtQWRkZWQnLCBzZXNzaW9uKVxuICAgYXR0YWNoTWVkaWFTdHJlYW0oc2Vzc2lvbi5zdHJlYW0sIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZW1vdGVWaWRlbycpKVxuICB9KVxuICBqaW5nbGUub24oJ2xvY2FsU3RyZWFtJywgZnVuY3Rpb24gKHN0cmVhbSkge1xuICAgIGlmIChmYWxzZSA9PT0gbG9jYWxTdGFydGVkKSB7XG4gICAgICBhdHRhY2hNZWRpYVN0cmVhbShzdHJlYW0sIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbFZpZGVvJyksIHsgbXV0ZWQ6IHRydWUsIG1pcnJvcjogdHJ1ZSB9KVxuICAgICAgbG9jYWxTdGFydGVkID0gdHJ1ZVxuICAgIH1cbiAgfSlcbiAgamluZ2xlLm9uKCdzZW5kJywgZnVuY3Rpb24oZGF0YSkge1xuICAgIGlmIChkYXRhLmppbmdsZSAmJiAoZGF0YS5qaW5nbGUuYWN0aW9uID09ICdzZXNzaW9uLWFjY2VwdCcpKSB7XG4gICAgICBjb25zb2xlLmRlYnVnKCdzZW5kaW5nJywgZGF0YSlcbiAgICAgIHdpbmRvdy5qaW5nbGVBY2NlcHQgPSBkYXRhXG4gICAgfVxuICAgIHNvY2tldC5lbWl0KCd4bXBwLmppbmdsZS5yZXF1ZXN0JywgZGF0YSwgZnVuY3Rpb24oZXJyb3IsIHN1Y2Nlc3MpIHtcbiAgICAgIGlmIChlcnJvcikgcmV0dXJuIGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCcsIGVycm9yKVxuICAgICAgY29uc29sZS5sb2coZGF0YS5qaW5nbGUuYWN0aW9uICsgJyBhY2snLCBzdWNjZXNzKVxuICAgIH0pXG4gIH0pXG5cbiAgdmFyIGNhbGxJbmZvID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbGxJbmZvJylcbiAgY2FsbEluZm8ub25zdWJtaXQgPSBmdW5jdGlvbiAoZSkge1xuICAgIGUucHJldmVudERlZmF1bHQoKVxuICAgIHZhciBqaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncGVlcicpLnZhbHVlXG4gICAgamluZ2xlLnN0YXJ0TG9jYWxNZWRpYShudWxsLCBmdW5jdGlvbiAoZXJyb3IsIHN0cmVhbSkge1xuICAgICAgbG9jYWxTdGFydGVkID0gdHJ1ZVxuICAgICAgdmFyIHNlc3MgPSBqaW5nbGUuY3JlYXRlTWVkaWFTZXNzaW9uKGppZClcbiAgICAgIHNlc3Muc3RhcnQoKVxuICAgICAgY29uc29sZS5sb2coJ0NhbGxpbmcgJyArIGppZClcbiAgICB9KVxuICAgIHJldHVybiBmYWxzZVxuICB9XG4gIHJldHVybiBmYWxzZVxufVxuXG5zb2NrZXQub24oJ3htcHAuZXJyb3IuY2xpZW50JywgZnVuY3Rpb24oZXJyb3IpIHtcbiAgY29uc29sZS5lcnJvcihlcnJvcilcbn0pXG5cbmppbmdsZS5zdGFydExvY2FsTWVkaWEobnVsbCwgZnVuY3Rpb24gKGVycm9yLCBzdHJlYW0pIHtcbiAgaWYgKGVycm9yKSByZXR1cm4gY29uc29sZS5lcnJvcihlcnJvcilcbiAgYXR0YWNoTWVkaWFTdHJlYW0oc3RyZWFtLCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jYWxWaWRlbycpLCB7IG11dGVkOiB0cnVlLCBtaXJyb3I6IHRydWUgfSlcbiAgbG9jYWxTdGFydGVkID0gdHJ1ZVxufSlcblxuc29ja2V0Lm9uKCd4bXBwLmppbmdsZS5yZXF1ZXN0JywgZnVuY3Rpb24oZGF0YSkge1xuICBpZiAoZmFsc2UgPT09IGxvY2FsU3RhcnRlZCkge1xuICAgIGppbmdsZS5zdGFydExvY2FsTWVkaWEobnVsbCwgZnVuY3Rpb24gKGVycm9yLCBzdHJlYW0pIHtcbiAgICAgIGlmIChlcnJvcikgcmV0dXJuIGNvbnNvbGUuZXJyb3IoZXJyb3IpXG4gICAgICBhdHRhY2hNZWRpYVN0cmVhbShzdHJlYW0sIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NhbFZpZGVvJyksIHsgbXV0ZWQ6IHRydWUsIG1pcnJvcjogdHJ1ZSB9KVxuICAgIH0pXG4gICAgbG9jYWxTdGFydGVkID0gdHJ1ZVxuICB9XG4gIGppbmdsZS5wcm9jZXNzKGRhdGEpXG59KVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoc3RyZWFtLCBlbCwgb3B0aW9ucykge1xuICAgIHZhciBVUkwgPSB3aW5kb3cuVVJMO1xuICAgIHZhciBvcHRzID0ge1xuICAgICAgICBhdXRvcGxheTogdHJ1ZSxcbiAgICAgICAgbWlycm9yOiBmYWxzZSxcbiAgICAgICAgbXV0ZWQ6IGZhbHNlXG4gICAgfTtcbiAgICB2YXIgZWxlbWVudCA9IGVsIHx8IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3ZpZGVvJyk7XG4gICAgdmFyIGl0ZW07XG5cbiAgICBpZiAob3B0aW9ucykge1xuICAgICAgICBmb3IgKGl0ZW0gaW4gb3B0aW9ucykge1xuICAgICAgICAgICAgb3B0c1tpdGVtXSA9IG9wdGlvbnNbaXRlbV07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAob3B0cy5hdXRvcGxheSkgZWxlbWVudC5hdXRvcGxheSA9ICdhdXRvcGxheSc7XG4gICAgaWYgKG9wdHMubXV0ZWQpIGVsZW1lbnQubXV0ZWQgPSB0cnVlO1xuICAgIGlmIChvcHRzLm1pcnJvcikge1xuICAgICAgICBbJycsICdtb3onLCAnd2Via2l0JywgJ28nLCAnbXMnXS5mb3JFYWNoKGZ1bmN0aW9uIChwcmVmaXgpIHtcbiAgICAgICAgICAgIHZhciBzdHlsZU5hbWUgPSBwcmVmaXggPyBwcmVmaXggKyAnVHJhbnNmb3JtJyA6ICd0cmFuc2Zvcm0nO1xuICAgICAgICAgICAgZWxlbWVudC5zdHlsZVtzdHlsZU5hbWVdID0gJ3NjYWxlWCgtMSknO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyB0aGlzIGZpcnN0IG9uZSBzaG91bGQgd29yayBtb3N0IGV2ZXJ5d2hlcmUgbm93XG4gICAgLy8gYnV0IHdlIGhhdmUgYSBmZXcgZmFsbGJhY2tzIGp1c3QgaW4gY2FzZS5cbiAgICBpZiAoVVJMICYmIFVSTC5jcmVhdGVPYmplY3RVUkwpIHtcbiAgICAgICAgZWxlbWVudC5zcmMgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKHN0cmVhbSk7XG4gICAgfSBlbHNlIGlmIChlbGVtZW50LnNyY09iamVjdCkge1xuICAgICAgICBlbGVtZW50LnNyY09iamVjdCA9IHN0cmVhbTtcbiAgICB9IGVsc2UgaWYgKGVsZW1lbnQubW96U3JjT2JqZWN0KSB7XG4gICAgICAgIGVsZW1lbnQubW96U3JjT2JqZWN0ID0gc3RyZWFtO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZWxlbWVudDtcbn07XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcblxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG5wcm9jZXNzLm5leHRUaWNrID0gKGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgY2FuU2V0SW1tZWRpYXRlID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cuc2V0SW1tZWRpYXRlO1xuICAgIHZhciBjYW5Qb3N0ID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cucG9zdE1lc3NhZ2UgJiYgd2luZG93LmFkZEV2ZW50TGlzdGVuZXJcbiAgICA7XG5cbiAgICBpZiAoY2FuU2V0SW1tZWRpYXRlKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoZikgeyByZXR1cm4gd2luZG93LnNldEltbWVkaWF0ZShmKSB9O1xuICAgIH1cblxuICAgIGlmIChjYW5Qb3N0KSB7XG4gICAgICAgIHZhciBxdWV1ZSA9IFtdO1xuICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIGZ1bmN0aW9uIChldikge1xuICAgICAgICAgICAgaWYgKGV2LnNvdXJjZSA9PT0gd2luZG93ICYmIGV2LmRhdGEgPT09ICdwcm9jZXNzLXRpY2snKSB7XG4gICAgICAgICAgICAgICAgZXYuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZuID0gcXVldWUuc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHRydWUpO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgICAgICB3aW5kb3cucG9zdE1lc3NhZ2UoJ3Byb2Nlc3MtdGljaycsICcqJyk7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZm4sIDApO1xuICAgIH07XG59KSgpO1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbiIsIm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9saWIvc2Vzc2lvbk1hbmFnZXInKTtcbiIsInZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIGFzeW5jID0gcmVxdWlyZSgnYXN5bmMnKTtcbnZhciBXaWxkRW1pdHRlciA9IHJlcXVpcmUoJ3dpbGRlbWl0dGVyJyk7XG52YXIgSmluZ2xlUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdqaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24nKTtcbnZhciBKaW5nbGVKU09OID0gcmVxdWlyZSgnc2RwLWppbmdsZS1qc29uJyk7XG5cblxudmFyIGxvZyA9IGJvd3MoJ0ppbmdsZVNlc3Npb24nKTtcblxuXG5mdW5jdGlvbiBhY3Rpb25Ub01ldGhvZChhY3Rpb24pIHtcbiAgICB2YXIgd29yZHMgPSBhY3Rpb24uc3BsaXQoJy0nKTtcbiAgICByZXR1cm4gJ29uJyArIHdvcmRzWzBdWzBdLnRvVXBwZXJDYXNlKCkgKyB3b3Jkc1swXS5zdWJzdHIoMSkgKyB3b3Jkc1sxXVswXS50b1VwcGVyQ2FzZSgpICsgd29yZHNbMV0uc3Vic3RyKDEpO1xufVxuXG5cbmZ1bmN0aW9uIEppbmdsZVNlc3Npb24ob3B0cykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLnNpZCA9IG9wdHMuc2lkIHx8IERhdGUubm93KCkudG9TdHJpbmcoKTtcbiAgICB0aGlzLnBlZXIgPSBvcHRzLnBlZXI7XG4gICAgdGhpcy5pc0luaXRpYXRvciA9IG9wdHMuaW5pdGlhdG9yIHx8IGZhbHNlO1xuICAgIHRoaXMuc3RhdGUgPSAnc3RhcnRpbmcnO1xuICAgIHRoaXMucGFyZW50ID0gb3B0cy5wYXJlbnQ7XG5cbiAgICB0aGlzLnByb2Nlc3NpbmdRdWV1ZSA9IGFzeW5jLnF1ZXVlKGZ1bmN0aW9uICh0YXNrLCBuZXh0KSB7XG4gICAgICAgIHZhciBhY3Rpb24gID0gdGFzay5hY3Rpb247XG4gICAgICAgIHZhciBjaGFuZ2VzID0gdGFzay5jaGFuZ2VzO1xuICAgICAgICB2YXIgY2IgPSB0YXNrLmNiO1xuXG4gICAgICAgIGxvZyhzZWxmLnNpZCArICc6ICcgKyBhY3Rpb24pO1xuICAgICAgICBzZWxmW2FjdGlvbl0oY2hhbmdlcywgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgY2IoZXJyKTtcbiAgICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG59XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShXaWxkRW1pdHRlci5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogSmluZ2xlU2Vzc2lvblxuICAgIH1cbn0pO1xuXG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnByb2Nlc3MgPSBmdW5jdGlvbiAoYWN0aW9uLCBjaGFuZ2VzLCBjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHZhciBtZXRob2QgPSBhY3Rpb25Ub01ldGhvZChhY3Rpb24pO1xuXG4gICAgdGhpcy5wcm9jZXNzaW5nUXVldWUucHVzaCh7XG4gICAgICAgIGFjdGlvbjogbWV0aG9kLFxuICAgICAgICBjaGFuZ2VzOiBjaGFuZ2VzLFxuICAgICAgICBjYjogY2JcbiAgICB9KTtcbn07XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAodHlwZSwgZGF0YSkge1xuICAgIGRhdGEgPSBkYXRhIHx8IHt9O1xuICAgIGRhdGEuc2lkID0gdGhpcy5zaWQ7XG4gICAgZGF0YS5hY3Rpb24gPSB0eXBlO1xuICAgIHRoaXMucGFyZW50LmVtaXQoJ3NlbmQnLCB7XG4gICAgICAgIHRvOiB0aGlzLnBlZXIsXG4gICAgICAgIHR5cGU6ICdzZXQnLFxuICAgICAgICBqaW5nbGU6IGRhdGFcbiAgICB9KTtcbn07XG5cbk9iamVjdC5kZWZpbmVQcm9wZXJ0eShKaW5nbGVTZXNzaW9uLnByb3RvdHlwZSwgJ3N0YXRlJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGU7XG4gICAgfSxcbiAgICBzZXQ6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICB2YXIgdmFsaWRTdGF0ZXMgPSB7XG4gICAgICAgICAgICBzdGFydGluZzogdHJ1ZSxcbiAgICAgICAgICAgIHBlbmRpbmc6IHRydWUsXG4gICAgICAgICAgICBhY3RpdmU6IHRydWUsXG4gICAgICAgICAgICBlbmRlZDogdHJ1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIGlmICghdmFsaWRTdGF0ZXNbdmFsdWVdKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgSmluZ2xlIFNlc3Npb24gU3RhdGU6ICcgKyB2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5fc3RhdGUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICB0aGlzLl9zdGF0ZSA9IHZhbHVlO1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogU3RhdGUgY2hhbmdlZCB0byAnICsgdmFsdWUpO1xuICAgICAgICB9XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdzdGFydGluZycsIHtcbiAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3N0YXRlID09ICdzdGFydGluZyc7XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdwZW5kaW5nJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGUgPT0gJ3BlbmRpbmcnO1xuICAgIH1cbn0pO1xuT2JqZWN0LmRlZmluZVByb3BlcnR5KEppbmdsZVNlc3Npb24ucHJvdG90eXBlLCAnYWN0aXZlJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc3RhdGUgPT0gJ2FjdGl2ZSc7XG4gICAgfVxufSk7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGUsICdlbmRlZCcsIHtcbiAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3N0YXRlID09ICdlbmRlZCc7XG4gICAgfVxufSk7XG5cbkppbmdsZVNlc3Npb24ucHJvdG90eXBlLnN0YXJ0ID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuc3RhdGUgPSAncGVuZGluZyc7XG4gICAgbG9nKHRoaXMuc2lkICsgJzogQ2FuIG5vdCBzdGFydCBnZW5lcmljIHNlc3Npb24nKTtcbn07XG5KaW5nbGVTZXNzaW9uLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAocmVhc29uLCBzaWxlbmNlKSB7XG4gICAgdGhpcy5wYXJlbnQucGVlcnNbdGhpcy5wZWVyXS5zcGxpY2UodGhpcy5wYXJlbnQucGVlcnNbdGhpcy5wZWVyXS5pbmRleE9mKHRoaXMpLCAxKTtcbiAgICBkZWxldGUgdGhpcy5wYXJlbnQuc2Vzc2lvbnNbdGhpcy5zaWRdO1xuXG4gICAgdGhpcy5zdGF0ZSA9ICdlbmRlZCc7XG5cbiAgICByZWFzb24gPSByZWFzb24gfHwge307XG5cbiAgICBpZiAoIXNpbGVuY2UpIHtcbiAgICAgICAgdGhpcy5zZW5kKCdzZXNzaW9uLXRlcm1pbmF0ZScsIHtyZWFzb246IHJlYXNvbn0pO1xuICAgIH1cblxuICAgIHRoaXMucGFyZW50LmVtaXQoJ3Rlcm1pbmF0ZWQnLCB0aGlzLCByZWFzb24pO1xufTtcblxudmFyIGFjdGlvbnMgPSBbXG4gICAgJ2NvbnRlbnQtYWNjZXB0JywgJ2NvbnRlbnQtYWRkJywgJ2NvbnRlbnQtbW9kaWZ5JyxcbiAgICAnY29uZW50LXJlamVjdCcsICdjb250ZW50LXJlbW92ZScsICdkZXNjcmlwdGlvbi1pbmZvJyxcbiAgICAnc2Vzc2lvbi1hY2NlcHQnLCAnc2Vzc2lvbi1pbmZvJywgJ3Nlc3Npb24taW5pdGlhdGUnLFxuICAgICdzZXNzaW9uLXRlcm1pbmF0ZScsICd0cmFuc3BvcnQtYWNjZXB0JywgJ3RyYW5zcG9ydC1pbmZvJyxcbiAgICAndHJhbnNwb3J0LXJlamVjdCcsICd0cmFuc3BvcnQtcmVwbGFjZSdcbl07XG5cbmFjdGlvbnMuZm9yRWFjaChmdW5jdGlvbiAoYWN0aW9uKSB7XG4gICAgdmFyIG1ldGhvZCA9IGFjdGlvblRvTWV0aG9kKGFjdGlvbik7XG4gICAgSmluZ2xlU2Vzc2lvbi5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uIChjaGFuZ2VzLCBjYikge1xuICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBVbnN1cHBvcnRlZCBhY3Rpb24gJyArIGFjdGlvbik7XG4gICAgICAgIGNiKCk7XG4gICAgfTtcbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEppbmdsZVNlc3Npb247XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIEppbmdsZVNlc3Npb24gPSByZXF1aXJlKCcuL2dlbmVyaWNTZXNzaW9uJyk7XG52YXIgSmluZ2xlUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdqaW5nbGUtcnRjcGVlcmNvbm5lY3Rpb24nKTtcblxuXG52YXIgbG9nID0gYm93cygnSmluZ2xlTWVkaWEnKTtcblxuXG5mdW5jdGlvbiBNZWRpYVNlc3Npb24ob3B0cykge1xuICAgIEppbmdsZVNlc3Npb24uY2FsbCh0aGlzLCBvcHRzKTtcblxuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIHRoaXMucGMgPSBuZXcgSmluZ2xlUGVlckNvbm5lY3Rpb24odGhpcy5wYXJlbnQuY29uZmlnLnBlZXJDb25uZWN0aW9uQ29uZmlnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wYXJlbnQuY29uZmlnLnBlZXJDb25uZWN0aW9uQ29uc3RyYWludHMpO1xuICAgIHRoaXMucGMub24oJ2ljZScsIHRoaXMub25JY2VDYW5kaWRhdGUuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5wYy5vbignYWRkU3RyZWFtJywgdGhpcy5vblN0cmVhbUFkZGVkLmJpbmQodGhpcykpO1xuICAgIHRoaXMucGMub24oJ3JlbW92ZVN0cmVhbScsIHRoaXMub25TdHJlYW1SZW1vdmVkLmJpbmQodGhpcykpO1xuICAgIHRoaXMucGVuZGluZ0Fuc3dlciA9IG51bGw7XG5cbiAgICBpZiAodGhpcy5wYXJlbnQubG9jYWxTdHJlYW0pIHtcbiAgICAgICAgdGhpcy5wYy5hZGRTdHJlYW0odGhpcy5wYXJlbnQubG9jYWxTdHJlYW0pO1xuICAgICAgICB0aGlzLmxvY2FsU3RyZWFtID0gdGhpcy5wYXJlbnQubG9jYWxTdHJlYW07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5wYXJlbnQub25jZSgnbG9jYWxTdHJlYW0nLCBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgICAgICAgICBzZWxmLnBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgICAgICAgICAgdGhpcy5sb2NhbFN0cmVhbSA9IHN0cmVhbTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5zdHJlYW0gPSBudWxsO1xufVxuXG5NZWRpYVNlc3Npb24ucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShKaW5nbGVTZXNzaW9uLnByb3RvdHlwZSwge1xuICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBNZWRpYVNlc3Npb25cbiAgICB9XG59KTtcblxuTWVkaWFTZXNzaW9uLnByb3RvdHlwZSA9IF8uZXh0ZW5kKE1lZGlhU2Vzc2lvbi5wcm90b3R5cGUsIHtcbiAgICBzdGFydDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAncGVuZGluZyc7XG4gICAgICAgIHRoaXMucGMuaXNJbml0aWF0b3IgPSB0cnVlO1xuICAgICAgICB0aGlzLnBjLm9mZmVyKGZ1bmN0aW9uIChlcnIsIHNlc3NEZXNjKSB7XG4gICAgICAgICAgICBzZWxmLnNlbmQoJ3Nlc3Npb24taW5pdGlhdGUnLCBzZXNzRGVzYy5qc29uKTtcbiAgICAgICAgfSk7XG4gICAgfSxcbiAgICBlbmQ6IGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgICAgdGhpcy5wYy5jbG9zZSgpO1xuICAgICAgICB0aGlzLm9uU3RyZWFtUmVtb3ZlZCgpO1xuICAgICAgICBKaW5nbGVTZXNzaW9uLnByb3RvdHlwZS5lbmQuY2FsbCh0aGlzLCByZWFzb24pO1xuICAgIH0sXG4gICAgYWNjZXB0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGxvZyh0aGlzLnNpZCArICc6IEFjY2VwdGVkIGluY29taW5nIHNlc3Npb24nKTtcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdhY3RpdmUnO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24tYWNjZXB0JywgdGhpcy5wZW5kaW5nQW5zd2VyKTtcbiAgICB9LFxuICAgIHJpbmc6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmluZ2luZyBvbiBpbmNvbWluZyBzZXNzaW9uJyk7XG4gICAgICAgIHRoaXMuc2VuZCgnc2Vzc2lvbi1pbmZvJywge3Jpbmdpbmc6IHRydWV9KTtcbiAgICB9LFxuICAgIG11dGU6IGZ1bmN0aW9uIChjcmVhdG9yLCBuYW1lKSB7XG4gICAgICAgIGxvZyh0aGlzLnNpZCArICc6IE11dGluZycpO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24taW5mbycsIHttdXRlOiB7Y3JlYXRvcjogY3JlYXRvciwgbmFtZTogbmFtZX19KTtcbiAgICB9LFxuICAgIHVubXV0ZTogZnVuY3Rpb24gKGNyZWF0b3IsIG5hbWUpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVW5tdXRpbmcnKTtcbiAgICAgICAgdGhpcy5zZW5kKCdzZXNzaW9uLWluZm8nLCB7dW5tdXRlOiB7Y3JlYXRvcjogY3JlYXRvciwgbmFtZTogbmFtZX19KTtcbiAgICB9LFxuICAgIGhvbGQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUGxhY2luZyBvbiBob2xkJyk7XG4gICAgICAgIHRoaXMuc2VuZCgnc2Vzc2lvbi1pbmZvJywge2hvbGQ6IHRydWV9KTtcbiAgICB9LFxuICAgIHJlc3VtZTogZnVuY3Rpb24gKCkge1xuICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZXN1aW5nIGZyb20gaG9sZCcpO1xuICAgICAgICB0aGlzLnNlbmQoJ3Nlc3Npb24taW5mbycsIHthY3RpdmU6IHRydWV9KTtcbiAgICB9LFxuICAgIG9uU2Vzc2lvbkluaXRpYXRlOiBmdW5jdGlvbiAoY2hhbmdlcywgY2IpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogSW5pdGlhdGluZyBpbmNvbWluZyBzZXNzaW9uJyk7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgdGhpcy5zdGF0ZSA9ICdwZW5kaW5nJztcbiAgICAgICAgdGhpcy5wYy5pc0luaXRpYXRvciA9IGZhbHNlO1xuICAgICAgICB0aGlzLnBjLmFuc3dlcih7dHlwZTogJ29mZmVyJywganNvbjogY2hhbmdlc30sIGZ1bmN0aW9uIChlcnIsIGFuc3dlcikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIGxvZyhzZWxmLnNpZCArICc6IENvdWxkIG5vdCBjcmVhdGUgV2ViUlRDIGFuc3dlcicsIGVycik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNiKHtjb25kaXRpb246ICdnZW5lcmFsLWVycm9yJ30pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2VsZi5wZW5kaW5nQW5zd2VyID0gYW5zd2VyLmpzb247XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICB9KTtcbiAgICB9LFxuICAgIG9uU2Vzc2lvbkFjY2VwdDogZnVuY3Rpb24gKGNoYW5nZXMsIGNiKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogQWN0aXZhdGluZyBhY2NlcHRlZCBvdXRib3VuZCBzZXNzaW9uJyk7XG4gICAgICAgIHRoaXMuc3RhdGUgPSAnYWN0aXZlJztcbiAgICAgICAgdGhpcy5wYy5oYW5kbGVBbnN3ZXIoe3R5cGU6ICdhbnN3ZXInLCBqc29uOiBjaGFuZ2VzfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIGxvZyhzZWxmLnNpZCArICc6IENvdWxkIG5vdCBwcm9jZXNzIFdlYlJUQyBhbnN3ZXInLCBlcnIpO1xuICAgICAgICAgICAgICAgIHJldHVybiBjYih7Y29uZGl0aW9uOiAnZ2VuZXJhbC1lcnJvcid9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc2VsZi5wYXJlbnQuZW1pdCgnYWNjZXB0ZWQnLCBzZWxmKTtcbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gICAgb25TZXNzaW9uVGVybWluYXRlOiBmdW5jdGlvbiAoY2hhbmdlcywgY2IpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVGVybWluYXRpbmcgc2Vzc2lvbicpO1xuICAgICAgICB0aGlzLnBjLmNsb3NlKCk7XG4gICAgICAgIHRoaXMub25TdHJlYW1SZW1vdmVkKCk7XG4gICAgICAgIEppbmdsZVNlc3Npb24ucHJvdG90eXBlLmVuZC5jYWxsKHRoaXMsIGNoYW5nZXMucmVhc29uLCB0cnVlKTtcbiAgICAgICAgY2IoKTtcbiAgICB9LFxuICAgIG9uVHJhbnNwb3J0SW5mbzogZnVuY3Rpb24gKGNoYW5nZXMsIGNiKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogQWRkaW5nIElDRSBjYW5kaWRhdGUnKTtcbiAgICAgICAgdGhpcy5wYy5wcm9jZXNzSWNlKGNoYW5nZXMsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBsb2coc2VsZi5zaWQgKyAnOiBDb3VsZCBub3QgcHJvY2VzcyBJQ0UgY2FuZGlkYXRlJywgZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNiKCk7XG4gICAgICAgIH0pO1xuICAgIH0sXG4gICAgb25TZXNzaW9uSW5mbzogZnVuY3Rpb24gKGluZm8sIGNiKSB7XG4gICAgICAgIGxvZyhpbmZvKTtcbiAgICAgICAgaWYgKGluZm8ucmluZ2luZykge1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmluZ2luZyBvbiByZW1vdGUgc3RyZWFtJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdyaW5naW5nJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5ob2xkKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBPbiBob2xkJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdob2xkJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hY3RpdmUpIHtcbiAgICAgICAgICAgIGxvZyh0aGlzLnNpZCArICc6IFJlc3VtZWQgZnJvbSBob2xkJyk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdyZXN1bWVkJywgdGhpcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5tdXRlKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBNdXRlZCcsIGluZm8ubXV0ZSk7XG4gICAgICAgICAgICB0aGlzLnBhcmVudC5lbWl0KCdtdXRlJywgdGhpcywgaW5mby5tdXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVubXV0ZSkge1xuICAgICAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogVW5tdXRlZCcsIGluZm8udW5tdXRlKTtcbiAgICAgICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3VubXV0ZScsIHRoaXMsIGluZm8udW5tdXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNiKCk7XG4gICAgfSxcbiAgICBvbkljZUNhbmRpZGF0ZTogZnVuY3Rpb24gKGNhbmRpZGF0ZUluZm8pIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogRGlzY292ZXJlZCBuZXcgSUNFIGNhbmRpZGF0ZScsIGNhbmRpZGF0ZUluZm8pO1xuICAgICAgICB0aGlzLnNlbmQoJ3RyYW5zcG9ydC1pbmZvJywgY2FuZGlkYXRlSW5mbyk7XG4gICAgfSxcbiAgICBvblN0cmVhbUFkZGVkOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgaWYgKHRoaXMuc3RyZWFtKSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZWNlaXZlZCByZW1vdGUgc3RyZWFtLCBidXQgb25lIGFscmVhZHkgZXhpc3RzJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2codGhpcy5zaWQgKyAnOiBSZW1vdGUgbWVkaWEgc3RyZWFtIGFkZGVkJyk7XG4gICAgICAgICAgICB0aGlzLnN0cmVhbSA9IGV2ZW50LnN0cmVhbTtcbiAgICAgICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3BlZXJTdHJlYW1BZGRlZCcsIHRoaXMpO1xuICAgICAgICB9XG4gICAgfSxcbiAgICBvblN0cmVhbVJlbW92ZWQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgbG9nKHRoaXMuc2lkICsgJzogUmVtb3RlIG1lZGlhIHN0cmVhbSByZW1vdmVkJyk7XG4gICAgICAgIHRoaXMucGFyZW50LmVtaXQoJ3BlZXJTdHJlYW1SZW1vdmVkJywgdGhpcyk7XG4gICAgfVxufSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBNZWRpYVNlc3Npb247XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciBib3dzID0gcmVxdWlyZSgnYm93cycpO1xudmFyIGhhcmsgPSByZXF1aXJlKCdoYXJrJyk7XG52YXIgd2VicnRjID0gcmVxdWlyZSgnd2VicnRjc3VwcG9ydCcpO1xudmFyIG1vY2tjb25zb2xlID0gcmVxdWlyZSgnbW9ja2NvbnNvbGUnKTtcbnZhciBnZXRVc2VyTWVkaWEgPSByZXF1aXJlKCdnZXR1c2VybWVkaWEnKTtcbnZhciBKaW5nbGVQZWVyQ29ubmVjdGlvbiA9IHJlcXVpcmUoJ2ppbmdsZS1ydGNwZWVyY29ubmVjdGlvbicpO1xudmFyIFdpbGRFbWl0dGVyID0gcmVxdWlyZSgnd2lsZGVtaXR0ZXInKTtcbnZhciBHYWluQ29udHJvbGxlciA9IHJlcXVpcmUoJ21lZGlhc3RyZWFtLWdhaW4nKTtcblxudmFyIEdlbmVyaWNTZXNzaW9uID0gcmVxdWlyZSgnLi9nZW5lcmljU2Vzc2lvbicpO1xudmFyIE1lZGlhU2Vzc2lvbiA9IHJlcXVpcmUoJy4vbWVkaWFTZXNzaW9uJyk7XG5cblxudmFyIGxvZyA9IGJvd3MoJ0ppbmdsZScpO1xuXG5cbmZ1bmN0aW9uIEppbmdsZShvcHRzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIHZhciBjb25maWcgPSB0aGlzLmNvbmZpZyA9IHtcbiAgICAgICAgZGVidWc6IGZhbHNlLFxuICAgICAgICBwZWVyQ29ubmVjdGlvbkNvbmZpZzoge1xuICAgICAgICAgICAgaWNlU2VydmVyczogW3tcInVybFwiOiBcInN0dW46c3R1bi5sLmdvb2dsZS5jb206MTkzMDJcIn1dXG4gICAgICAgIH0sXG4gICAgICAgIHBlZXJDb25uZWN0aW9uQ29uc3RyYWludHM6IHtcbiAgICAgICAgICAgIG9wdGlvbmFsOiBbXG4gICAgICAgICAgICAgICAge0R0bHNTcnRwS2V5QWdyZWVtZW50OiB0cnVlfSxcbiAgICAgICAgICAgICAgICB7UnRwRGF0YUNoYW5uZWxzOiBmYWxzZX1cbiAgICAgICAgICAgIF1cbiAgICAgICAgfSxcbiAgICAgICAgYXV0b0FkanVzdE1pYzogZmFsc2UsXG4gICAgICAgIG1lZGlhOiB7XG4gICAgICAgICAgICBhdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgIHZpZGVvOiB0cnVlXG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgdGhpcy5NZWRpYVNlc3Npb24gPSBNZWRpYVNlc3Npb247XG4gICAgdGhpcy5qaWQgPSBvcHRzLmppZDtcbiAgICB0aGlzLnNlc3Npb25zID0ge307XG4gICAgdGhpcy5wZWVycyA9IHt9O1xuXG4gICAgdGhpcy5zY3JlZW5TaGFyaW5nU3VwcG9ydCA9IHdlYnJ0Yy5zY3JlZW5TaGFyaW5nO1xuXG4gICAgZm9yICh2YXIgaXRlbSBpbiBvcHRzKSB7XG4gICAgICAgIGNvbmZpZ1tpdGVtXSA9IG9wdHNbaXRlbV07XG4gICAgfVxuXG4gICAgdGhpcy5jYXBhYmlsaXRpZXMgPSBbXG4gICAgICAgICd1cm46eG1wcDpqaW5nbGU6MSdcbiAgICBdO1xuICAgIGlmICh3ZWJydGMuc3VwcG9ydCkge1xuICAgICAgICB0aGlzLmNhcGFiaWxpdGllcyA9IFtcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6MScsXG4gICAgICAgICAgICAndXJuOnhtcHA6amluZ2xlOmFwcHM6cnRwOjEnLFxuICAgICAgICAgICAgJ3Vybjp4bXBwOmppbmdsZTphcHBzOnJ0cDphdWRpbycsXG4gICAgICAgICAgICAndXJuOnhtcHA6amluZ2xlOmFwcHM6cnRwOnZpZGVvJyxcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6YXBwczpydHA6cnRjYi1mYjowJyxcbiAgICAgICAgICAgICd1cm46eG1wcDpqaW5nbGU6YXBwczpkdGxzOjAnLFxuICAgICAgICAgICAgJ3Vybjp4bXBwOmppbmdsZTp0cmFuc3BvcnRzOmljZS11ZHA6MScsXG4gICAgICAgICAgICAndXJuOmlldGY6cmZjOjMyNjQnXG4gICAgICAgIF07XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbG9nKCdXZWJSVEMgbm90IHN1cHBvcnRlZCcpO1xuICAgIH1cblxuICAgIFdpbGRFbWl0dGVyLmNhbGwodGhpcyk7XG5cbiAgICBpZiAodGhpcy5jb25maWcuZGVidWcpIHtcbiAgICAgICAgdGhpcy5vbignKicsIGZ1bmN0aW9uIChldmVudCwgdmFsMSwgdmFsMikge1xuICAgICAgICAgICAgbG9nKGV2ZW50LCB2YWwxLCB2YWwyKTtcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5KaW5nbGUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShXaWxkRW1pdHRlci5wcm90b3R5cGUsIHtcbiAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogSmluZ2xlXG4gICAgfVxufSk7XG5cbkppbmdsZS5wcm90b3R5cGUuc3RhcnRMb2NhbE1lZGlhID0gZnVuY3Rpb24gKG1lZGlhQ29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBjb25zdHJhaW50cyA9IG1lZGlhQ29uc3RyYWludHMgfHwge3ZpZGVvOiB0cnVlLCBhdWRpbzogdHJ1ZX07XG5cbiAgICBnZXRVc2VyTWVkaWEoY29uc3RyYWludHMsIGZ1bmN0aW9uIChlcnIsIHN0cmVhbSkge1xuICAgICAgICBpZiAoIWVycikge1xuICAgICAgICAgICAgaWYgKGNvbnN0cmFpbnRzLmF1ZGlvICYmIHNlbGYuY29uZmlnLmRldGVjdFNwZWFraW5nRXZlbnRzKSB7XG4gICAgICAgICAgICAgICAgc2VsZi5zZXR1cEF1ZGlvTW9uaXRvcihzdHJlYW0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2VsZi5sb2NhbFN0cmVhbSA9IHN0cmVhbTtcblxuICAgICAgICAgICAgaWYgKHNlbGYuY29uZmlnLmF1dG9BZGp1c3RNaWMpIHtcbiAgICAgICAgICAgICAgICBzZWxmLmdhaW5Db250cm9sbGVyID0gbmV3IEdhaW5Db250cm9sbGVyKHN0cmVhbSk7XG4gICAgICAgICAgICAgICAgc2VsZi5zZXRNaWNJZkVuYWJsZWQoMC41KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbG9nKCdMb2NhbCBtZWRpYSBzdHJlYW0gc3RhcnRlZCcpO1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdsb2NhbFN0cmVhbScsIHN0cmVhbSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2coJ0NvdWxkIG5vdCBzdGFydCBsb2NhbCBtZWRpYScpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjYikgY2IoZXJyLCBzdHJlYW0pO1xuICAgIH0pO1xufTtcblxuSmluZ2xlLnByb3RvdHlwZS5zdG9wTG9jYWxNZWRpYSA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAodGhpcy5sb2NhbFN0cmVhbSkge1xuICAgICAgICB0aGlzLmxvY2FsU3RyZWFtLnN0b3AoKTtcbiAgICAgICAgdGhpcy5lbWl0KCdsb2NhbFN0cmVhbVN0b3BwZWQnKTtcbiAgICB9XG59O1xuXG5KaW5nbGUucHJvdG90eXBlLnNldHVwQXVkaW9Nb25pdG9yID0gZnVuY3Rpb24gKHN0cmVhbSkge1xuICAgIGxvZygnU2V0dXAgYXVkaW8nKTtcbiAgICB2YXIgYXVkaW8gPSBoYXJrKHN0cmVhbSk7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciB0aW1lb3V0O1xuXG4gICAgYXVkaW8ub24oJ3NwZWFraW5nJywgZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAoc2VsZi5oYXJkTXV0ZWQpIHJldHVybjtcbiAgICAgICAgc2VsZi5zZXRNaWNJZkVuYWJsZWQoMSk7XG4gICAgICAgIHNlbGYuZW1pdCgnc3BlYWtpbmcnKTtcbiAgICB9KTtcblxuICAgIGF1ZGlvLm9uKCdzdG9wcGVkX3NwZWFraW5nJywgZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAoc2VsZi5oYXJkTXV0ZWQpIHJldHVybjtcbiAgICAgICAgaWYgKHRpbWVvdXQpIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblxuICAgICAgICB0aW1lb3V0ID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZWxmLnNldE1pY0lmRW5hYmxlZCgwLjUpO1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdzdG9wcGVkU3BlYWtpbmcnKTtcbiAgICAgICAgfSwgMTAwMCk7XG4gICAgfSk7XG59O1xuXG5KaW5nbGUucHJvdG90eXBlLnNldE1pY0lmRW5hYmxlZCA9IGZ1bmN0aW9uICh2b2x1bWUpIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLmF1dG9BZGp1c3RNaWMpIHJldHVybjtcbiAgICB0aGlzLmdhaW5Db250cm9sbGVyLnNldEdhaW4odm9sdW1lKTtcbn07XG5cbkppbmdsZS5wcm90b3R5cGUuc2VuZEVycm9yID0gZnVuY3Rpb24gKHRvLCBpZCwgZGF0YSkge1xuICAgIGRhdGEudHlwZSA9ICdjYW5jZWwnO1xuICAgIHRoaXMuZW1pdCgnc2VuZCcsIHtcbiAgICAgICAgdG86IHRvLFxuICAgICAgICBpZDogaWQsXG4gICAgICAgIHR5cGU6ICdlcnJvcicsXG4gICAgICAgIGVycm9yOiBkYXRhXG4gICAgfSk7XG59O1xuXG5KaW5nbGUucHJvdG90eXBlLnByb2Nlc3MgPSBmdW5jdGlvbiAocmVxKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgaWYgKHJlcS50eXBlID09PSAnZXJyb3InKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmVtaXQoJ2Vycm9yJywgcmVxKTtcbiAgICB9XG5cbiAgICBpZiAocmVxLnR5cGUgPT09ICdyZXN1bHQnKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB2YXIgc2lkcywgY3VycnNpZCwgc2VzcztcbiAgICB2YXIgc2lkID0gcmVxLmppbmdsZS5zaWQ7XG4gICAgdmFyIGFjdGlvbiA9IHJlcS5qaW5nbGUuYWN0aW9uO1xuICAgIHZhciBjb250ZW50cyA9IHJlcS5qaW5nbGUuY29udGVudHMgfHwgW107XG4gICAgdmFyIGNvbnRlbnRUeXBlcyA9IF8ubWFwKGNvbnRlbnRzLCBmdW5jdGlvbiAoY29udGVudCkge1xuICAgICAgICByZXR1cm4gKGNvbnRlbnQuZGVzY3JpcHRpb24gfHwge30pLmRlc2NUeXBlO1xuICAgIH0pO1xuXG4gICAgdmFyIHNlc3Npb24gPSB0aGlzLnNlc3Npb25zW3NpZF0gfHwgbnVsbDtcblxuICAgIHZhciBzZW5kZXIgPSByZXEuZnJvbS5mdWxsIHx8IHJlcS5mcm9tO1xuICAgIHZhciByZXFpZCA9IHJlcS5pZDtcblxuICAgIGlmIChhY3Rpb24gIT09ICdzZXNzaW9uLWluaXRpYXRlJykge1xuICAgICAgICAvLyBDYW4ndCBtb2RpZnkgYSBzZXNzaW9uIHRoYXQgd2UgZG9uJ3QgaGF2ZS5cbiAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICBsb2coJ1Vua25vd24gc2Vzc2lvbicsIHNpZCk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbjogJ2l0ZW0tbm90LWZvdW5kJyxcbiAgICAgICAgICAgICAgICBqaW5nbGVDb25kaXRpb246ICd1bmtub3duLXNlc3Npb24nXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENoZWNrIGlmIHNvbWVvbmUgaXMgdHJ5aW5nIHRvIGhpamFjayBhIHNlc3Npb24uXG4gICAgICAgIGlmIChzZXNzaW9uLnBlZXIgIT09IHNlbmRlciB8fCBzZXNzaW9uLmVuZGVkKSB7XG4gICAgICAgICAgICBsb2coJ1Nlc3Npb24gaGFzIGVuZGVkLCBvciBhY3Rpb24gaGFzIHdyb25nIHNlbmRlcicpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuc2VuZEVycm9yKHNlbmRlciwgcmVxaWQsIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb246ICdpdGVtLW5vdC1mb3VuZCcsXG4gICAgICAgICAgICAgICAgamluZ2xlQ29uZGl0aW9uOiAndW5rbm93bi1zZXNzaW9uJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDYW4ndCBhY2NlcHQgYSBzZXNzaW9uIHR3aWNlXG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdzZXNzaW9uLWFjY2VwdCcgJiYgIXNlc3Npb24ucGVuZGluZykge1xuICAgICAgICAgICAgbG9nKCdUcmllZCB0byBhY2NlcHQgc2Vzc2lvbiB0d2ljZScsIHNpZCk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbjogJ3VuZXhwZWN0ZWQtcmVxdWVzdCcsXG4gICAgICAgICAgICAgICAgamluZ2xlQ29uZGl0aW9uOiAnb3V0LW9mLW9yZGVyJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDYW4ndCBwcm9jZXNzIHR3byByZXF1ZXN0cyBhdCBvbmNlLCBuZWVkIHRvIHRpZSBicmVha1xuICAgICAgICBpZiAoYWN0aW9uICE9PSAnc2Vzc2lvbi10ZXJtaW5hdGUnICYmIHNlc3Npb24ucGVuZGluZ0FjdGlvbikge1xuICAgICAgICAgICAgbG9nKCdUaWUgYnJlYWsgZHVyaW5nIHBlbmRpbmcgcmVxdWVzdCcpO1xuICAgICAgICAgICAgaWYgKHNlc3Npb24uaXNJbml0aWF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb246ICdjb25mbGljdCcsXG4gICAgICAgICAgICAgICAgICAgIGppbmdsZUNvbmRpdGlvbjogJ3RpZS1icmVhaydcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAoc2Vzc2lvbikge1xuICAgICAgICAvLyBEb24ndCBhY2NlcHQgYSBuZXcgc2Vzc2lvbiBpZiB3ZSBhbHJlYWR5IGhhdmUgb25lLlxuICAgICAgICBpZiAoc2Vzc2lvbi5wZWVyICE9PSBzZW5kZXIpIHtcbiAgICAgICAgICAgIGxvZygnRHVwbGljYXRlIHNpZCBmcm9tIG5ldyBzZW5kZXInKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnNlbmRFcnJvcihzZW5kZXIsIHJlcWlkLCB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uOiAnc2VydmljZS11bmF2YWlsYWJsZSdcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ2hlY2sgaWYgd2UgbmVlZCB0byBoYXZlIGEgdGllIGJyZWFrZXIgYmVjYXVzZSBib3RoIHBhcnRpZXNcbiAgICAgICAgLy8gaGFwcGVuZWQgdG8gcGljayB0aGUgc2FtZSByYW5kb20gc2lkLlxuICAgICAgICBpZiAoc2Vzc2lvbi5wZW5kaW5nKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5qaWQgPiBzZXNzaW9uLnBlZXIpIHtcbiAgICAgICAgICAgICAgICBsb2coJ1RpZSBicmVhayBuZXcgc2Vzc2lvbiBiZWNhdXNlIG9mIGR1cGxpY2F0ZSBzaWRzJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuc2VuZEVycm9yKHNlbmRlciwgcmVxaWQsIHtcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uOiAnY29uZmxpY3QnLFxuICAgICAgICAgICAgICAgICAgICBqaW5nbGVDb25kaXRpb246ICd0aWUtYnJlYWsnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUaGUgb3RoZXIgc2lkZSBpcyBqdXN0IGRvaW5nIGl0IHdyb25nLlxuICAgICAgICBsb2coJ1NvbWVvbmUgaXMgZG9pbmcgdGhpcyB3cm9uZycpO1xuICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgY29uZGl0aW9uOiAndW5leHBlY3RlZC1yZXF1ZXN0JyxcbiAgICAgICAgICAgIGppbmdsZUNvbmRpdGlvbjogJ291dC1vZi1vcmRlcidcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChPYmplY3Qua2V5cyh0aGlzLnBlZXJzW3NlbmRlcl0gfHwge30pLmxlbmd0aCkge1xuICAgICAgICAvLyBDaGVjayBpZiB3ZSBuZWVkIHRvIGhhdmUgYSB0aWUgYnJlYWtlciBiZWNhdXNlIHdlIGFscmVhZHkgaGF2ZSBcbiAgICAgICAgLy8gYSBkaWZmZXJlbnQgc2Vzc2lvbiB0aGF0IGlzIHVzaW5nIHRoZSByZXF1ZXN0ZWQgY29udGVudCB0eXBlcy5cbiAgICAgICAgc2lkcyA9IE9iamVjdC5rZXlzKHRoaXMucGVlcnNbc2VuZGVyXSk7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2lkcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY3VycnNpZCA9IHNpZHNbaV07XG4gICAgICAgICAgICBzZXNzID0gdGhpcy5zZXNzaW9uc1tjdXJyc2lkXTtcbiAgICAgICAgICAgIGlmIChzZXNzLnBlbmRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pbnRlcnNlY3Rpb24oY29udGVudFR5cGVzLCBzZXNzLmNvbnRlbnRUeXBlcykubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGFscmVhZHkgaGF2ZSBhIHBlbmRpbmcgc2Vzc2lvbiByZXF1ZXN0IGZvciB0aGlzIGNvbnRlbnQgdHlwZS5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGN1cnJzaWQgPiBzaWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFdlIHdvbiB0aGUgdGllIGJyZWFrZXJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZygnVGllIGJyZWFrJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5zZW5kRXJyb3Ioc2VuZGVyLCByZXFpZCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvbjogJ2NvbmZsaWN0JyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBqaW5nbGVDb25kaXRpb246ICd0aWUtYnJlYWsnXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlmIChhY3Rpb24gPT09ICdzZXNzaW9uLWluaXRpYXRlJykge1xuICAgICAgICB2YXIgb3B0cyA9IHtcbiAgICAgICAgICAgIHNpZDogc2lkLFxuICAgICAgICAgICAgcGVlcjogc2VuZGVyLFxuICAgICAgICAgICAgaW5pdGlhdG9yOiBmYWxzZSxcbiAgICAgICAgICAgIHBhcmVudDogdGhpc1xuICAgICAgICB9O1xuICAgICAgICBpZiAoY29udGVudFR5cGVzLmluZGV4T2YoJ3J0cCcpID49IDApIHtcbiAgICAgICAgICAgIHNlc3Npb24gPSBuZXcgTWVkaWFTZXNzaW9uKG9wdHMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2Vzc2lvbiA9IG5ldyBHZW5lcmljU2Vzc2lvbihvcHRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuc2Vzc2lvbnNbc2lkXSA9IHNlc3Npb247XG4gICAgICAgIGlmICghdGhpcy5wZWVyc1tzZW5kZXJdKSB7XG4gICAgICAgICAgICB0aGlzLnBlZXJzW3NlbmRlcl0gPSBbXTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnBlZXJzW3NlbmRlcl0ucHVzaChzZXNzaW9uKTtcbiAgICB9XG5cbiAgICBzZXNzaW9uLnByb2Nlc3MoYWN0aW9uLCByZXEuamluZ2xlLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgIGxvZygnQ291bGQgbm90IHByb2Nlc3MgcmVxdWVzdCcsIHJlcSwgZXJyKTtcbiAgICAgICAgICAgIHNlbGYuc2VuZEVycm9yKHNlbmRlciwgcmVxaWQsIGVycik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ3NlbmQnLCB7dG86IHNlbmRlciwgaWQ6IHJlcWlkLCB0eXBlOiAncmVzdWx0J30pO1xuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3Nlc3Npb24taW5pdGlhdGUnKSB7XG4gICAgICAgICAgICAgICAgbG9nKCdJbmNvbWluZyBzZXNzaW9uIHJlcXVlc3QgZnJvbSAnLCBzZW5kZXIsIHNlc3Npb24pO1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnaW5jb21pbmcnLCBzZXNzaW9uKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0pO1xufTtcblxuSmluZ2xlLnByb3RvdHlwZS5jcmVhdGVNZWRpYVNlc3Npb24gPSBmdW5jdGlvbiAocGVlciwgc2lkKSB7XG4gICAgdmFyIHNlc3Npb24gPSBuZXcgTWVkaWFTZXNzaW9uKHtcbiAgICAgICAgc2lkOiBzaWQsXG4gICAgICAgIHBlZXI6IHBlZXIsXG4gICAgICAgIGluaXRpYXRvcjogdHJ1ZSxcbiAgICAgICAgcGFyZW50OiB0aGlzXG4gICAgfSk7XG5cbiAgICBzaWQgPSBzZXNzaW9uLnNpZDtcblxuICAgIHRoaXMuc2Vzc2lvbnNbc2lkXSA9IHNlc3Npb247XG4gICAgaWYgKCF0aGlzLnBlZXJzW3BlZXJdKSB7XG4gICAgICAgIHRoaXMucGVlcnNbcGVlcl0gPSBbXTtcbiAgICB9XG4gICAgdGhpcy5wZWVyc1twZWVyXS5wdXNoKHNlc3Npb24pO1xuXG4gICAgbG9nKCdPdXRnb2luZyBzZXNzaW9uJywgc2Vzc2lvbi5zaWQsIHNlc3Npb24pO1xuICAgIHRoaXMuZW1pdCgnb3V0Z29pbmcnLCBzZXNzaW9uKTtcbiAgICByZXR1cm4gc2Vzc2lvbjtcbn07XG5cbkppbmdsZS5wcm90b3R5cGUuZW5kUGVlclNlc3Npb25zID0gZnVuY3Rpb24gKHBlZXIpIHtcbiAgICBsb2coJ0VuZGluZyBhbGwgc2Vzc2lvbnMgd2l0aCcsIHBlZXIpO1xuICAgIHZhciBzZXNzaW9ucyA9IHRoaXMucGVlcnNbcGVlcl0gfHwgW107XG4gICAgc2Vzc2lvbnMuZm9yRWFjaChmdW5jdGlvbiAoc2Vzc2lvbikge1xuICAgICAgICBzZXNzaW9uLmVuZCgpO1xuICAgIH0pO1xufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IEppbmdsZTtcbiIsInZhciBwcm9jZXNzPXJlcXVpcmUoXCJfX2Jyb3dzZXJpZnlfcHJvY2Vzc1wiKTsvKmdsb2JhbCBzZXRJbW1lZGlhdGU6IGZhbHNlLCBzZXRUaW1lb3V0OiBmYWxzZSwgY29uc29sZTogZmFsc2UgKi9cbihmdW5jdGlvbiAoKSB7XG5cbiAgICB2YXIgYXN5bmMgPSB7fTtcblxuICAgIC8vIGdsb2JhbCBvbiB0aGUgc2VydmVyLCB3aW5kb3cgaW4gdGhlIGJyb3dzZXJcbiAgICB2YXIgcm9vdCwgcHJldmlvdXNfYXN5bmM7XG5cbiAgICByb290ID0gdGhpcztcbiAgICBpZiAocm9vdCAhPSBudWxsKSB7XG4gICAgICBwcmV2aW91c19hc3luYyA9IHJvb3QuYXN5bmM7XG4gICAgfVxuXG4gICAgYXN5bmMubm9Db25mbGljdCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcm9vdC5hc3luYyA9IHByZXZpb3VzX2FzeW5jO1xuICAgICAgICByZXR1cm4gYXN5bmM7XG4gICAgfTtcblxuICAgIGZ1bmN0aW9uIG9ubHlfb25jZShmbikge1xuICAgICAgICB2YXIgY2FsbGVkID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChjYWxsZWQpIHRocm93IG5ldyBFcnJvcihcIkNhbGxiYWNrIHdhcyBhbHJlYWR5IGNhbGxlZC5cIik7XG4gICAgICAgICAgICBjYWxsZWQgPSB0cnVlO1xuICAgICAgICAgICAgZm4uYXBwbHkocm9vdCwgYXJndW1lbnRzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vLy8gY3Jvc3MtYnJvd3NlciBjb21wYXRpYmxpdHkgZnVuY3Rpb25zIC8vLy9cblxuICAgIHZhciBfZWFjaCA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yKSB7XG4gICAgICAgIGlmIChhcnIuZm9yRWFjaCkge1xuICAgICAgICAgICAgcmV0dXJuIGFyci5mb3JFYWNoKGl0ZXJhdG9yKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyci5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgICAgaXRlcmF0b3IoYXJyW2ldLCBpLCBhcnIpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHZhciBfbWFwID0gZnVuY3Rpb24gKGFyciwgaXRlcmF0b3IpIHtcbiAgICAgICAgaWYgKGFyci5tYXApIHtcbiAgICAgICAgICAgIHJldHVybiBhcnIubWFwKGl0ZXJhdG9yKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgICBfZWFjaChhcnIsIGZ1bmN0aW9uICh4LCBpLCBhKSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goaXRlcmF0b3IoeCwgaSwgYSkpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfTtcblxuICAgIHZhciBfcmVkdWNlID0gZnVuY3Rpb24gKGFyciwgaXRlcmF0b3IsIG1lbW8pIHtcbiAgICAgICAgaWYgKGFyci5yZWR1Y2UpIHtcbiAgICAgICAgICAgIHJldHVybiBhcnIucmVkdWNlKGl0ZXJhdG9yLCBtZW1vKTtcbiAgICAgICAgfVxuICAgICAgICBfZWFjaChhcnIsIGZ1bmN0aW9uICh4LCBpLCBhKSB7XG4gICAgICAgICAgICBtZW1vID0gaXRlcmF0b3IobWVtbywgeCwgaSwgYSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gbWVtbztcbiAgICB9O1xuXG4gICAgdmFyIF9rZXlzID0gZnVuY3Rpb24gKG9iaikge1xuICAgICAgICBpZiAoT2JqZWN0LmtleXMpIHtcbiAgICAgICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhvYmopO1xuICAgICAgICB9XG4gICAgICAgIHZhciBrZXlzID0gW107XG4gICAgICAgIGZvciAodmFyIGsgaW4gb2JqKSB7XG4gICAgICAgICAgICBpZiAob2JqLmhhc093blByb3BlcnR5KGspKSB7XG4gICAgICAgICAgICAgICAga2V5cy5wdXNoKGspO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBrZXlzO1xuICAgIH07XG5cbiAgICAvLy8vIGV4cG9ydGVkIGFzeW5jIG1vZHVsZSBmdW5jdGlvbnMgLy8vL1xuXG4gICAgLy8vLyBuZXh0VGljayBpbXBsZW1lbnRhdGlvbiB3aXRoIGJyb3dzZXItY29tcGF0aWJsZSBmYWxsYmFjayAvLy8vXG4gICAgaWYgKHR5cGVvZiBwcm9jZXNzID09PSAndW5kZWZpbmVkJyB8fCAhKHByb2Nlc3MubmV4dFRpY2spKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2V0SW1tZWRpYXRlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBhc3luYy5uZXh0VGljayA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgICAgIC8vIG5vdCBhIGRpcmVjdCBhbGlhcyBmb3IgSUUxMCBjb21wYXRpYmlsaXR5XG4gICAgICAgICAgICAgICAgc2V0SW1tZWRpYXRlKGZuKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBhc3luYy5uZXh0VGljaztcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGFzeW5jLm5leHRUaWNrID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmbiwgMCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlID0gYXN5bmMubmV4dFRpY2s7XG4gICAgICAgIH1cbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICAgIGFzeW5jLm5leHRUaWNrID0gcHJvY2Vzcy5uZXh0VGljaztcbiAgICAgICAgaWYgKHR5cGVvZiBzZXRJbW1lZGlhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBzZXRJbW1lZGlhdGU7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUgPSBhc3luYy5uZXh0VGljaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jLmVhY2ggPSBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKCFhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgY29tcGxldGVkID0gMDtcbiAgICAgICAgX2VhY2goYXJyLCBmdW5jdGlvbiAoeCkge1xuICAgICAgICAgICAgaXRlcmF0b3IoeCwgb25seV9vbmNlKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb21wbGV0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbXBsZXRlZCA+PSBhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5mb3JFYWNoID0gYXN5bmMuZWFjaDtcblxuICAgIGFzeW5jLmVhY2hTZXJpZXMgPSBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKCFhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgY29tcGxldGVkID0gMDtcbiAgICAgICAgdmFyIGl0ZXJhdGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpdGVyYXRvcihhcnJbY29tcGxldGVkXSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbXBsZXRlZCArPSAxO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY29tcGxldGVkID49IGFyci5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgaXRlcmF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG4gICAgICAgIGl0ZXJhdGUoKTtcbiAgICB9O1xuICAgIGFzeW5jLmZvckVhY2hTZXJpZXMgPSBhc3luYy5lYWNoU2VyaWVzO1xuXG4gICAgYXN5bmMuZWFjaExpbWl0ID0gZnVuY3Rpb24gKGFyciwgbGltaXQsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgZm4gPSBfZWFjaExpbWl0KGxpbWl0KTtcbiAgICAgICAgZm4uYXBwbHkobnVsbCwgW2FyciwgaXRlcmF0b3IsIGNhbGxiYWNrXSk7XG4gICAgfTtcbiAgICBhc3luYy5mb3JFYWNoTGltaXQgPSBhc3luYy5lYWNoTGltaXQ7XG5cbiAgICB2YXIgX2VhY2hMaW1pdCA9IGZ1bmN0aW9uIChsaW1pdCkge1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICBpZiAoIWFyci5sZW5ndGggfHwgbGltaXQgPD0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGNvbXBsZXRlZCA9IDA7XG4gICAgICAgICAgICB2YXIgc3RhcnRlZCA9IDA7XG4gICAgICAgICAgICB2YXIgcnVubmluZyA9IDA7XG5cbiAgICAgICAgICAgIChmdW5jdGlvbiByZXBsZW5pc2ggKCkge1xuICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgPj0gYXJyLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB3aGlsZSAocnVubmluZyA8IGxpbWl0ICYmIHN0YXJ0ZWQgPCBhcnIubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0ZWQgKz0gMTtcbiAgICAgICAgICAgICAgICAgICAgcnVubmluZyArPSAxO1xuICAgICAgICAgICAgICAgICAgICBpdGVyYXRvcihhcnJbc3RhcnRlZCAtIDFdLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGxldGVkICs9IDE7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcnVubmluZyAtPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgPj0gYXJyLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVwbGVuaXNoKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSgpO1xuICAgICAgICB9O1xuICAgIH07XG5cblxuICAgIHZhciBkb1BhcmFsbGVsID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW2FzeW5jLmVhY2hdLmNvbmNhdChhcmdzKSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICB2YXIgZG9QYXJhbGxlbExpbWl0ID0gZnVuY3Rpb24obGltaXQsIGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW19lYWNoTGltaXQobGltaXQpXS5jb25jYXQoYXJncykpO1xuICAgICAgICB9O1xuICAgIH07XG4gICAgdmFyIGRvU2VyaWVzID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkobnVsbCwgW2FzeW5jLmVhY2hTZXJpZXNdLmNvbmNhdChhcmdzKSk7XG4gICAgICAgIH07XG4gICAgfTtcblxuXG4gICAgdmFyIF9hc3luY01hcCA9IGZ1bmN0aW9uIChlYWNoZm4sIGFyciwgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciByZXN1bHRzID0gW107XG4gICAgICAgIGFyciA9IF9tYXAoYXJyLCBmdW5jdGlvbiAoeCwgaSkge1xuICAgICAgICAgICAgcmV0dXJuIHtpbmRleDogaSwgdmFsdWU6IHh9O1xuICAgICAgICB9KTtcbiAgICAgICAgZWFjaGZuKGFyciwgZnVuY3Rpb24gKHgsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBpdGVyYXRvcih4LnZhbHVlLCBmdW5jdGlvbiAoZXJyLCB2KSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0c1t4LmluZGV4XSA9IHY7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIGFzeW5jLm1hcCA9IGRvUGFyYWxsZWwoX2FzeW5jTWFwKTtcbiAgICBhc3luYy5tYXBTZXJpZXMgPSBkb1NlcmllcyhfYXN5bmNNYXApO1xuICAgIGFzeW5jLm1hcExpbWl0ID0gZnVuY3Rpb24gKGFyciwgbGltaXQsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICByZXR1cm4gX21hcExpbWl0KGxpbWl0KShhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgfTtcblxuICAgIHZhciBfbWFwTGltaXQgPSBmdW5jdGlvbihsaW1pdCkge1xuICAgICAgICByZXR1cm4gZG9QYXJhbGxlbExpbWl0KGxpbWl0LCBfYXN5bmNNYXApO1xuICAgIH07XG5cbiAgICAvLyByZWR1Y2Ugb25seSBoYXMgYSBzZXJpZXMgdmVyc2lvbiwgYXMgZG9pbmcgcmVkdWNlIGluIHBhcmFsbGVsIHdvbid0XG4gICAgLy8gd29yayBpbiBtYW55IHNpdHVhdGlvbnMuXG4gICAgYXN5bmMucmVkdWNlID0gZnVuY3Rpb24gKGFyciwgbWVtbywgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMoYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKG1lbW8sIHgsIGZ1bmN0aW9uIChlcnIsIHYpIHtcbiAgICAgICAgICAgICAgICBtZW1vID0gdjtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVyciwgbWVtbyk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgLy8gaW5qZWN0IGFsaWFzXG4gICAgYXN5bmMuaW5qZWN0ID0gYXN5bmMucmVkdWNlO1xuICAgIC8vIGZvbGRsIGFsaWFzXG4gICAgYXN5bmMuZm9sZGwgPSBhc3luYy5yZWR1Y2U7XG5cbiAgICBhc3luYy5yZWR1Y2VSaWdodCA9IGZ1bmN0aW9uIChhcnIsIG1lbW8sIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgcmV2ZXJzZWQgPSBfbWFwKGFyciwgZnVuY3Rpb24gKHgpIHtcbiAgICAgICAgICAgIHJldHVybiB4O1xuICAgICAgICB9KS5yZXZlcnNlKCk7XG4gICAgICAgIGFzeW5jLnJlZHVjZShyZXZlcnNlZCwgbWVtbywgaXRlcmF0b3IsIGNhbGxiYWNrKTtcbiAgICB9O1xuICAgIC8vIGZvbGRyIGFsaWFzXG4gICAgYXN5bmMuZm9sZHIgPSBhc3luYy5yZWR1Y2VSaWdodDtcblxuICAgIHZhciBfZmlsdGVyID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIHJlc3VsdHMgPSBbXTtcbiAgICAgICAgYXJyID0gX21hcChhcnIsIGZ1bmN0aW9uICh4LCBpKSB7XG4gICAgICAgICAgICByZXR1cm4ge2luZGV4OiBpLCB2YWx1ZTogeH07XG4gICAgICAgIH0pO1xuICAgICAgICBlYWNoZm4oYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgudmFsdWUsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKHYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKF9tYXAocmVzdWx0cy5zb3J0KGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGEuaW5kZXggLSBiLmluZGV4O1xuICAgICAgICAgICAgfSksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHgudmFsdWU7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXN5bmMuZmlsdGVyID0gZG9QYXJhbGxlbChfZmlsdGVyKTtcbiAgICBhc3luYy5maWx0ZXJTZXJpZXMgPSBkb1NlcmllcyhfZmlsdGVyKTtcbiAgICAvLyBzZWxlY3QgYWxpYXNcbiAgICBhc3luYy5zZWxlY3QgPSBhc3luYy5maWx0ZXI7XG4gICAgYXN5bmMuc2VsZWN0U2VyaWVzID0gYXN5bmMuZmlsdGVyU2VyaWVzO1xuXG4gICAgdmFyIF9yZWplY3QgPSBmdW5jdGlvbiAoZWFjaGZuLCBhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgICAgICBhcnIgPSBfbWFwKGFyciwgZnVuY3Rpb24gKHgsIGkpIHtcbiAgICAgICAgICAgIHJldHVybiB7aW5kZXg6IGksIHZhbHVlOiB4fTtcbiAgICAgICAgfSk7XG4gICAgICAgIGVhY2hmbihhcnIsIGZ1bmN0aW9uICh4LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgaXRlcmF0b3IoeC52YWx1ZSwgZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0cy5wdXNoKHgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKF9tYXAocmVzdWx0cy5zb3J0KGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGEuaW5kZXggLSBiLmluZGV4O1xuICAgICAgICAgICAgfSksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHgudmFsdWU7XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXN5bmMucmVqZWN0ID0gZG9QYXJhbGxlbChfcmVqZWN0KTtcbiAgICBhc3luYy5yZWplY3RTZXJpZXMgPSBkb1NlcmllcyhfcmVqZWN0KTtcblxuICAgIHZhciBfZGV0ZWN0ID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBpdGVyYXRvciwgbWFpbl9jYWxsYmFjaykge1xuICAgICAgICBlYWNoZm4oYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2soeCk7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIG1haW5fY2FsbGJhY2soKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5kZXRlY3QgPSBkb1BhcmFsbGVsKF9kZXRlY3QpO1xuICAgIGFzeW5jLmRldGVjdFNlcmllcyA9IGRvU2VyaWVzKF9kZXRlY3QpO1xuXG4gICAgYXN5bmMuc29tZSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBtYWluX2NhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2goYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKHYpIHtcbiAgICAgICAgICAgICAgICAgICAgbWFpbl9jYWxsYmFjayh0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgbWFpbl9jYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIG1haW5fY2FsbGJhY2soZmFsc2UpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIC8vIGFueSBhbGlhc1xuICAgIGFzeW5jLmFueSA9IGFzeW5jLnNvbWU7XG5cbiAgICBhc3luYy5ldmVyeSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBtYWluX2NhbGxiYWNrKSB7XG4gICAgICAgIGFzeW5jLmVhY2goYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICAgICAgaWYgKCF2KSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5fY2FsbGJhY2soZmFsc2UpO1xuICAgICAgICAgICAgICAgICAgICBtYWluX2NhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgbWFpbl9jYWxsYmFjayh0cnVlKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICAvLyBhbGwgYWxpYXNcbiAgICBhc3luYy5hbGwgPSBhc3luYy5ldmVyeTtcblxuICAgIGFzeW5jLnNvcnRCeSA9IGZ1bmN0aW9uIChhcnIsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBhc3luYy5tYXAoYXJyLCBmdW5jdGlvbiAoeCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGl0ZXJhdG9yKHgsIGZ1bmN0aW9uIChlcnIsIGNyaXRlcmlhKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwge3ZhbHVlOiB4LCBjcml0ZXJpYTogY3JpdGVyaWF9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVyciwgcmVzdWx0cykge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgdmFyIGZuID0gZnVuY3Rpb24gKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhID0gbGVmdC5jcml0ZXJpYSwgYiA9IHJpZ2h0LmNyaXRlcmlhO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYSA8IGIgPyAtMSA6IGEgPiBiID8gMSA6IDA7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsLCBfbWFwKHJlc3VsdHMuc29ydChmbiksIGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB4LnZhbHVlO1xuICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLmF1dG8gPSBmdW5jdGlvbiAodGFza3MsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgIHZhciBrZXlzID0gX2tleXModGFza3MpO1xuICAgICAgICBpZiAoIWtleXMubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2sobnVsbCk7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuXG4gICAgICAgIHZhciBsaXN0ZW5lcnMgPSBbXTtcbiAgICAgICAgdmFyIGFkZExpc3RlbmVyID0gZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICBsaXN0ZW5lcnMudW5zaGlmdChmbik7XG4gICAgICAgIH07XG4gICAgICAgIHZhciByZW1vdmVMaXN0ZW5lciA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsaXN0ZW5lcnMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgICAgICAgICBpZiAobGlzdGVuZXJzW2ldID09PSBmbikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMuc3BsaWNlKGksIDEpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB2YXIgdGFza0NvbXBsZXRlID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgX2VhY2gobGlzdGVuZXJzLnNsaWNlKDApLCBmdW5jdGlvbiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgYWRkTGlzdGVuZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKF9rZXlzKHJlc3VsdHMpLmxlbmd0aCA9PT0ga2V5cy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayA9IGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfZWFjaChrZXlzLCBmdW5jdGlvbiAoaykge1xuICAgICAgICAgICAgdmFyIHRhc2sgPSAodGFza3Nba10gaW5zdGFuY2VvZiBGdW5jdGlvbikgPyBbdGFza3Nba11dOiB0YXNrc1trXTtcbiAgICAgICAgICAgIHZhciB0YXNrQ2FsbGJhY2sgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgICAgIGlmIChhcmdzLmxlbmd0aCA8PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBzYWZlUmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICBfZWFjaChfa2V5cyhyZXN1bHRzKSwgZnVuY3Rpb24ocmtleSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2FmZVJlc3VsdHNbcmtleV0gPSByZXN1bHRzW3JrZXldO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgc2FmZVJlc3VsdHNba10gPSBhcmdzO1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIsIHNhZmVSZXN1bHRzKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gc3RvcCBzdWJzZXF1ZW50IGVycm9ycyBoaXR0aW5nIGNhbGxiYWNrIG11bHRpcGxlIHRpbWVzXG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRzW2tdID0gYXJncztcbiAgICAgICAgICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlKHRhc2tDb21wbGV0ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHZhciByZXF1aXJlcyA9IHRhc2suc2xpY2UoMCwgTWF0aC5hYnModGFzay5sZW5ndGggLSAxKSkgfHwgW107XG4gICAgICAgICAgICB2YXIgcmVhZHkgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF9yZWR1Y2UocmVxdWlyZXMsIGZ1bmN0aW9uIChhLCB4KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAoYSAmJiByZXN1bHRzLmhhc093blByb3BlcnR5KHgpKTtcbiAgICAgICAgICAgICAgICB9LCB0cnVlKSAmJiAhcmVzdWx0cy5oYXNPd25Qcm9wZXJ0eShrKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBpZiAocmVhZHkoKSkge1xuICAgICAgICAgICAgICAgIHRhc2tbdGFzay5sZW5ndGggLSAxXSh0YXNrQ2FsbGJhY2ssIHJlc3VsdHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVhZHkoKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFza1t0YXNrLmxlbmd0aCAtIDFdKHRhc2tDYWxsYmFjaywgcmVzdWx0cyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGFkZExpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLndhdGVyZmFsbCA9IGZ1bmN0aW9uICh0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKHRhc2tzLmNvbnN0cnVjdG9yICE9PSBBcnJheSkge1xuICAgICAgICAgIHZhciBlcnIgPSBuZXcgRXJyb3IoJ0ZpcnN0IGFyZ3VtZW50IHRvIHdhdGVyZmFsbCBtdXN0IGJlIGFuIGFycmF5IG9mIGZ1bmN0aW9ucycpO1xuICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghdGFza3MubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgd3JhcEl0ZXJhdG9yID0gZnVuY3Rpb24gKGl0ZXJhdG9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkobnVsbCwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sgPSBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIG5leHQgPSBpdGVyYXRvci5uZXh0KCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChuZXh0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmdzLnB1c2god3JhcEl0ZXJhdG9yKG5leHQpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MucHVzaChjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYXN5bmMuc2V0SW1tZWRpYXRlKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGl0ZXJhdG9yLmFwcGx5KG51bGwsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICB3cmFwSXRlcmF0b3IoYXN5bmMuaXRlcmF0b3IodGFza3MpKSgpO1xuICAgIH07XG5cbiAgICB2YXIgX3BhcmFsbGVsID0gZnVuY3Rpb24oZWFjaGZuLCB0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICAgICAgaWYgKHRhc2tzLmNvbnN0cnVjdG9yID09PSBBcnJheSkge1xuICAgICAgICAgICAgZWFjaGZuLm1hcCh0YXNrcywgZnVuY3Rpb24gKGZuLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChmbikge1xuICAgICAgICAgICAgICAgICAgICBmbihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suY2FsbChudWxsLCBlcnIsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgZWFjaGZuLmVhY2goX2tleXModGFza3MpLCBmdW5jdGlvbiAoaywgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB0YXNrc1trXShmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZ3MubGVuZ3RoIDw9IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdHNba10gPSBhcmdzO1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0cyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBhc3luYy5wYXJhbGxlbCA9IGZ1bmN0aW9uICh0YXNrcywgY2FsbGJhY2spIHtcbiAgICAgICAgX3BhcmFsbGVsKHsgbWFwOiBhc3luYy5tYXAsIGVhY2g6IGFzeW5jLmVhY2ggfSwgdGFza3MsIGNhbGxiYWNrKTtcbiAgICB9O1xuXG4gICAgYXN5bmMucGFyYWxsZWxMaW1pdCA9IGZ1bmN0aW9uKHRhc2tzLCBsaW1pdCwgY2FsbGJhY2spIHtcbiAgICAgICAgX3BhcmFsbGVsKHsgbWFwOiBfbWFwTGltaXQobGltaXQpLCBlYWNoOiBfZWFjaExpbWl0KGxpbWl0KSB9LCB0YXNrcywgY2FsbGJhY2spO1xuICAgIH07XG5cbiAgICBhc3luYy5zZXJpZXMgPSBmdW5jdGlvbiAodGFza3MsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgZnVuY3Rpb24gKCkge307XG4gICAgICAgIGlmICh0YXNrcy5jb25zdHJ1Y3RvciA9PT0gQXJyYXkpIHtcbiAgICAgICAgICAgIGFzeW5jLm1hcFNlcmllcyh0YXNrcywgZnVuY3Rpb24gKGZuLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChmbikge1xuICAgICAgICAgICAgICAgICAgICBmbihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3MgPSBhcmdzWzBdO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2suY2FsbChudWxsLCBlcnIsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICB2YXIgcmVzdWx0cyA9IHt9O1xuICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhfa2V5cyh0YXNrcyksIGZ1bmN0aW9uIChrLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHRhc2tzW2tdKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJncy5sZW5ndGggPD0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJncyA9IGFyZ3NbMF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0c1trXSA9IGFyZ3M7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCByZXN1bHRzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGFzeW5jLml0ZXJhdG9yID0gZnVuY3Rpb24gKHRhc2tzKSB7XG4gICAgICAgIHZhciBtYWtlQ2FsbGJhY2sgPSBmdW5jdGlvbiAoaW5kZXgpIHtcbiAgICAgICAgICAgIHZhciBmbiA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAodGFza3MubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHRhc2tzW2luZGV4XS5hcHBseShudWxsLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZm4ubmV4dCgpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGZuLm5leHQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIChpbmRleCA8IHRhc2tzLmxlbmd0aCAtIDEpID8gbWFrZUNhbGxiYWNrKGluZGV4ICsgMSk6IG51bGw7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcmV0dXJuIGZuO1xuICAgICAgICB9O1xuICAgICAgICByZXR1cm4gbWFrZUNhbGxiYWNrKDApO1xuICAgIH07XG5cbiAgICBhc3luYy5hcHBseSA9IGZ1bmN0aW9uIChmbikge1xuICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gZm4uYXBwbHkoXG4gICAgICAgICAgICAgICAgbnVsbCwgYXJncy5jb25jYXQoQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKSlcbiAgICAgICAgICAgICk7XG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIHZhciBfY29uY2F0ID0gZnVuY3Rpb24gKGVhY2hmbiwgYXJyLCBmbiwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIHIgPSBbXTtcbiAgICAgICAgZWFjaGZuKGFyciwgZnVuY3Rpb24gKHgsIGNiKSB7XG4gICAgICAgICAgICBmbih4LCBmdW5jdGlvbiAoZXJyLCB5KSB7XG4gICAgICAgICAgICAgICAgciA9IHIuY29uY2F0KHkgfHwgW10pO1xuICAgICAgICAgICAgICAgIGNiKGVycik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyLCByKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBhc3luYy5jb25jYXQgPSBkb1BhcmFsbGVsKF9jb25jYXQpO1xuICAgIGFzeW5jLmNvbmNhdFNlcmllcyA9IGRvU2VyaWVzKF9jb25jYXQpO1xuXG4gICAgYXN5bmMud2hpbHN0ID0gZnVuY3Rpb24gKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBpZiAodGVzdCgpKSB7XG4gICAgICAgICAgICBpdGVyYXRvcihmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYXN5bmMud2hpbHN0KHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgYXN5bmMuZG9XaGlsc3QgPSBmdW5jdGlvbiAoaXRlcmF0b3IsIHRlc3QsIGNhbGxiYWNrKSB7XG4gICAgICAgIGl0ZXJhdG9yKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0ZXN0KCkpIHtcbiAgICAgICAgICAgICAgICBhc3luYy5kb1doaWxzdChpdGVyYXRvciwgdGVzdCwgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGFzeW5jLnVudGlsID0gZnVuY3Rpb24gKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjaykge1xuICAgICAgICBpZiAoIXRlc3QoKSkge1xuICAgICAgICAgICAgaXRlcmF0b3IoZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGFzeW5jLnVudGlsKHRlc3QsIGl0ZXJhdG9yLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgYXN5bmMuZG9VbnRpbCA9IGZ1bmN0aW9uIChpdGVyYXRvciwgdGVzdCwgY2FsbGJhY2spIHtcbiAgICAgICAgaXRlcmF0b3IoZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCF0ZXN0KCkpIHtcbiAgICAgICAgICAgICAgICBhc3luYy5kb1VudGlsKGl0ZXJhdG9yLCB0ZXN0LCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9O1xuXG4gICAgYXN5bmMucXVldWUgPSBmdW5jdGlvbiAod29ya2VyLCBjb25jdXJyZW5jeSkge1xuICAgICAgICBpZiAoY29uY3VycmVuY3kgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgY29uY3VycmVuY3kgPSAxO1xuICAgICAgICB9XG4gICAgICAgIGZ1bmN0aW9uIF9pbnNlcnQocSwgZGF0YSwgcG9zLCBjYWxsYmFjaykge1xuICAgICAgICAgIGlmKGRhdGEuY29uc3RydWN0b3IgIT09IEFycmF5KSB7XG4gICAgICAgICAgICAgIGRhdGEgPSBbZGF0YV07XG4gICAgICAgICAgfVxuICAgICAgICAgIF9lYWNoKGRhdGEsIGZ1bmN0aW9uKHRhc2spIHtcbiAgICAgICAgICAgICAgdmFyIGl0ZW0gPSB7XG4gICAgICAgICAgICAgICAgICBkYXRhOiB0YXNrLFxuICAgICAgICAgICAgICAgICAgY2FsbGJhY2s6IHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJyA/IGNhbGxiYWNrIDogbnVsbFxuICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgIGlmIChwb3MpIHtcbiAgICAgICAgICAgICAgICBxLnRhc2tzLnVuc2hpZnQoaXRlbSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcS50YXNrcy5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgaWYgKHEuc2F0dXJhdGVkICYmIHEudGFza3MubGVuZ3RoID09PSBjb25jdXJyZW5jeSkge1xuICAgICAgICAgICAgICAgICAgcS5zYXR1cmF0ZWQoKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUocS5wcm9jZXNzKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciB3b3JrZXJzID0gMDtcbiAgICAgICAgdmFyIHEgPSB7XG4gICAgICAgICAgICB0YXNrczogW10sXG4gICAgICAgICAgICBjb25jdXJyZW5jeTogY29uY3VycmVuY3ksXG4gICAgICAgICAgICBzYXR1cmF0ZWQ6IG51bGwsXG4gICAgICAgICAgICBlbXB0eTogbnVsbCxcbiAgICAgICAgICAgIGRyYWluOiBudWxsLFxuICAgICAgICAgICAgcHVzaDogZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgIF9pbnNlcnQocSwgZGF0YSwgZmFsc2UsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB1bnNoaWZ0OiBmdW5jdGlvbiAoZGF0YSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgX2luc2VydChxLCBkYXRhLCB0cnVlLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcHJvY2VzczogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmICh3b3JrZXJzIDwgcS5jb25jdXJyZW5jeSAmJiBxLnRhc2tzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgdGFzayA9IHEudGFza3Muc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHEuZW1wdHkgJiYgcS50YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHEuZW1wdHkoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB3b3JrZXJzICs9IDE7XG4gICAgICAgICAgICAgICAgICAgIHZhciBuZXh0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgd29ya2VycyAtPSAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhc2suY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXNrLmNhbGxiYWNrLmFwcGx5KHRhc2ssIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAocS5kcmFpbiAmJiBxLnRhc2tzLmxlbmd0aCArIHdvcmtlcnMgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBxLmRyYWluKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBxLnByb2Nlc3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNiID0gb25seV9vbmNlKG5leHQpO1xuICAgICAgICAgICAgICAgICAgICB3b3JrZXIodGFzay5kYXRhLCBjYik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGxlbmd0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBxLnRhc2tzLmxlbmd0aDtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBydW5uaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdvcmtlcnM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBxO1xuICAgIH07XG5cbiAgICBhc3luYy5jYXJnbyA9IGZ1bmN0aW9uICh3b3JrZXIsIHBheWxvYWQpIHtcbiAgICAgICAgdmFyIHdvcmtpbmcgICAgID0gZmFsc2UsXG4gICAgICAgICAgICB0YXNrcyAgICAgICA9IFtdO1xuXG4gICAgICAgIHZhciBjYXJnbyA9IHtcbiAgICAgICAgICAgIHRhc2tzOiB0YXNrcyxcbiAgICAgICAgICAgIHBheWxvYWQ6IHBheWxvYWQsXG4gICAgICAgICAgICBzYXR1cmF0ZWQ6IG51bGwsXG4gICAgICAgICAgICBlbXB0eTogbnVsbCxcbiAgICAgICAgICAgIGRyYWluOiBudWxsLFxuICAgICAgICAgICAgcHVzaDogZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYoZGF0YS5jb25zdHJ1Y3RvciAhPT0gQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YSA9IFtkYXRhXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgX2VhY2goZGF0YSwgZnVuY3Rpb24odGFzaykge1xuICAgICAgICAgICAgICAgICAgICB0YXNrcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGE6IHRhc2ssXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjazogdHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nID8gY2FsbGJhY2sgOiBudWxsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY2FyZ28uc2F0dXJhdGVkICYmIHRhc2tzLmxlbmd0aCA9PT0gcGF5bG9hZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FyZ28uc2F0dXJhdGVkKCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBhc3luYy5zZXRJbW1lZGlhdGUoY2FyZ28ucHJvY2Vzcyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcHJvY2VzczogZnVuY3Rpb24gcHJvY2VzcygpIHtcbiAgICAgICAgICAgICAgICBpZiAod29ya2luZykgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYoY2FyZ28uZHJhaW4pIGNhcmdvLmRyYWluKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdHMgPSB0eXBlb2YgcGF5bG9hZCA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHRhc2tzLnNwbGljZSgwLCBwYXlsb2FkKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdGFza3Muc3BsaWNlKDApO1xuXG4gICAgICAgICAgICAgICAgdmFyIGRzID0gX21hcCh0cywgZnVuY3Rpb24gKHRhc2spIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRhc2suZGF0YTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGlmKGNhcmdvLmVtcHR5KSBjYXJnby5lbXB0eSgpO1xuICAgICAgICAgICAgICAgIHdvcmtpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHdvcmtlcihkcywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICB3b3JraW5nID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICAgICAgICAgICAgICAgIF9lYWNoKHRzLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGRhdGEuY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLmNhbGxiYWNrLmFwcGx5KG51bGwsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBwcm9jZXNzKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgbGVuZ3RoOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRhc2tzLmxlbmd0aDtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBydW5uaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdvcmtpbmc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBjYXJnbztcbiAgICB9O1xuXG4gICAgdmFyIF9jb25zb2xlX2ZuID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgICAgICAgICAgZm4uYXBwbHkobnVsbCwgYXJncy5jb25jYXQoW2Z1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgICAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29uc29sZS5lcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBlbHNlIGlmIChjb25zb2xlW25hbWVdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBfZWFjaChhcmdzLCBmdW5jdGlvbiAoeCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGVbbmFtZV0oeCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1dKSk7XG4gICAgICAgIH07XG4gICAgfTtcbiAgICBhc3luYy5sb2cgPSBfY29uc29sZV9mbignbG9nJyk7XG4gICAgYXN5bmMuZGlyID0gX2NvbnNvbGVfZm4oJ2RpcicpO1xuICAgIC8qYXN5bmMuaW5mbyA9IF9jb25zb2xlX2ZuKCdpbmZvJyk7XG4gICAgYXN5bmMud2FybiA9IF9jb25zb2xlX2ZuKCd3YXJuJyk7XG4gICAgYXN5bmMuZXJyb3IgPSBfY29uc29sZV9mbignZXJyb3InKTsqL1xuXG4gICAgYXN5bmMubWVtb2l6ZSA9IGZ1bmN0aW9uIChmbiwgaGFzaGVyKSB7XG4gICAgICAgIHZhciBtZW1vID0ge307XG4gICAgICAgIHZhciBxdWV1ZXMgPSB7fTtcbiAgICAgICAgaGFzaGVyID0gaGFzaGVyIHx8IGZ1bmN0aW9uICh4KSB7XG4gICAgICAgICAgICByZXR1cm4geDtcbiAgICAgICAgfTtcbiAgICAgICAgdmFyIG1lbW9pemVkID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgICAgICAgICAgdmFyIGNhbGxiYWNrID0gYXJncy5wb3AoKTtcbiAgICAgICAgICAgIHZhciBrZXkgPSBoYXNoZXIuYXBwbHkobnVsbCwgYXJncyk7XG4gICAgICAgICAgICBpZiAoa2V5IGluIG1lbW8pIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseShudWxsLCBtZW1vW2tleV0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSBpZiAoa2V5IGluIHF1ZXVlcykge1xuICAgICAgICAgICAgICAgIHF1ZXVlc1trZXldLnB1c2goY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVldWVzW2tleV0gPSBbY2FsbGJhY2tdO1xuICAgICAgICAgICAgICAgIGZuLmFwcGx5KG51bGwsIGFyZ3MuY29uY2F0KFtmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lbW9ba2V5XSA9IGFyZ3VtZW50cztcbiAgICAgICAgICAgICAgICAgICAgdmFyIHEgPSBxdWV1ZXNba2V5XTtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHF1ZXVlc1trZXldO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMCwgbCA9IHEubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgcVtpXS5hcHBseShudWxsLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfV0pKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgbWVtb2l6ZWQubWVtbyA9IG1lbW87XG4gICAgICAgIG1lbW9pemVkLnVubWVtb2l6ZWQgPSBmbjtcbiAgICAgICAgcmV0dXJuIG1lbW9pemVkO1xuICAgIH07XG5cbiAgICBhc3luYy51bm1lbW9pemUgPSBmdW5jdGlvbiAoZm4pIHtcbiAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiAoZm4udW5tZW1vaXplZCB8fCBmbikuYXBwbHkobnVsbCwgYXJndW1lbnRzKTtcbiAgICAgIH07XG4gICAgfTtcblxuICAgIGFzeW5jLnRpbWVzID0gZnVuY3Rpb24gKGNvdW50LCBpdGVyYXRvciwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIGNvdW50ZXIgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb3VudDsgaSsrKSB7XG4gICAgICAgICAgICBjb3VudGVyLnB1c2goaSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGFzeW5jLm1hcChjb3VudGVyLCBpdGVyYXRvciwgY2FsbGJhY2spO1xuICAgIH07XG5cbiAgICBhc3luYy50aW1lc1NlcmllcyA9IGZ1bmN0aW9uIChjb3VudCwgaXRlcmF0b3IsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciBjb3VudGVyID0gW107XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY291bnQ7IGkrKykge1xuICAgICAgICAgICAgY291bnRlci5wdXNoKGkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBhc3luYy5tYXBTZXJpZXMoY291bnRlciwgaXRlcmF0b3IsIGNhbGxiYWNrKTtcbiAgICB9O1xuXG4gICAgYXN5bmMuY29tcG9zZSA9IGZ1bmN0aW9uICgvKiBmdW5jdGlvbnMuLi4gKi8pIHtcbiAgICAgICAgdmFyIGZucyA9IEFycmF5LnByb3RvdHlwZS5yZXZlcnNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB0aGF0ID0gdGhpcztcbiAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHZhciBjYWxsYmFjayA9IGFyZ3MucG9wKCk7XG4gICAgICAgICAgICBhc3luYy5yZWR1Y2UoZm5zLCBhcmdzLCBmdW5jdGlvbiAobmV3YXJncywgZm4sIGNiKSB7XG4gICAgICAgICAgICAgICAgZm4uYXBwbHkodGhhdCwgbmV3YXJncy5jb25jYXQoW2Z1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGVyciA9IGFyZ3VtZW50c1swXTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIG5leHRhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgY2IoZXJyLCBuZXh0YXJncyk7XG4gICAgICAgICAgICAgICAgfV0pKVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGZ1bmN0aW9uIChlcnIsIHJlc3VsdHMpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjay5hcHBseSh0aGF0LCBbZXJyXS5jb25jYXQocmVzdWx0cykpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIHZhciBfYXBwbHlFYWNoID0gZnVuY3Rpb24gKGVhY2hmbiwgZm5zIC8qYXJncy4uLiovKSB7XG4gICAgICAgIHZhciBnbyA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB0aGF0ID0gdGhpcztcbiAgICAgICAgICAgIHZhciBhcmdzID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHZhciBjYWxsYmFjayA9IGFyZ3MucG9wKCk7XG4gICAgICAgICAgICByZXR1cm4gZWFjaGZuKGZucywgZnVuY3Rpb24gKGZuLCBjYikge1xuICAgICAgICAgICAgICAgIGZuLmFwcGx5KHRoYXQsIGFyZ3MuY29uY2F0KFtjYl0pKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjYWxsYmFjayk7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgICAgICAgICAgcmV0dXJuIGdvLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIGdvO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBhc3luYy5hcHBseUVhY2ggPSBkb1BhcmFsbGVsKF9hcHBseUVhY2gpO1xuICAgIGFzeW5jLmFwcGx5RWFjaFNlcmllcyA9IGRvU2VyaWVzKF9hcHBseUVhY2gpO1xuXG4gICAgYXN5bmMuZm9yZXZlciA9IGZ1bmN0aW9uIChmbiwgY2FsbGJhY2spIHtcbiAgICAgICAgZnVuY3Rpb24gbmV4dChlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZuKG5leHQpO1xuICAgICAgICB9XG4gICAgICAgIG5leHQoKTtcbiAgICB9O1xuXG4gICAgLy8gQU1EIC8gUmVxdWlyZUpTXG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgIT09ICd1bmRlZmluZWQnICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKFtdLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gYXN5bmM7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICAvLyBOb2RlLmpzXG4gICAgZWxzZSBpZiAodHlwZW9mIG1vZHVsZSAhPT0gJ3VuZGVmaW5lZCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBhc3luYztcbiAgICB9XG4gICAgLy8gaW5jbHVkZWQgZGlyZWN0bHkgdmlhIDxzY3JpcHQ+IHRhZ1xuICAgIGVsc2Uge1xuICAgICAgICByb290LmFzeW5jID0gYXN5bmM7XG4gICAgfVxuXG59KCkpO1xuIiwiKGZ1bmN0aW9uKCkge1xuICB2YXIgaW5Ob2RlID0gdHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcsXG4gICAgICBscyA9ICFpbk5vZGUgJiYgd2luZG93LmxvY2FsU3RvcmFnZSxcbiAgICAgIGRlYnVnID0gbHMuZGVidWcsXG4gICAgICBsb2dnZXIgPSByZXF1aXJlKCdhbmRsb2cnKSxcbiAgICAgIGdvbGRlblJhdGlvID0gMC42MTgwMzM5ODg3NDk4OTUsXG4gICAgICBodWUgPSAwLFxuICAgICAgcGFkTGVuZ3RoID0gMTUsXG4gICAgICBub29wID0gZnVuY3Rpb24oKSB7fSxcbiAgICAgIHlpZWxkQ29sb3IsXG4gICAgICBib3dzLFxuICAgICAgZGVidWdSZWdleDtcblxuICB5aWVsZENvbG9yID0gZnVuY3Rpb24oKSB7XG4gICAgaHVlICs9IGdvbGRlblJhdGlvO1xuICAgIGh1ZSA9IGh1ZSAlIDE7XG4gICAgcmV0dXJuIGh1ZSAqIDM2MDtcbiAgfTtcblxuICB2YXIgZGVidWdSZWdleCA9IGRlYnVnICYmIGRlYnVnWzBdPT09Jy8nICYmIG5ldyBSZWdFeHAoZGVidWcuc3Vic3RyaW5nKDEsZGVidWcubGVuZ3RoLTEpKTtcblxuICBib3dzID0gZnVuY3Rpb24oc3RyKSB7XG4gICAgdmFyIG1zZztcbiAgICBtc2cgPSBcIiVjXCIgKyAoc3RyLnNsaWNlKDAsIHBhZExlbmd0aCkpO1xuICAgIG1zZyArPSBBcnJheShwYWRMZW5ndGggKyAzIC0gbXNnLmxlbmd0aCkuam9pbignICcpICsgJ3wnO1xuXG4gICAgaWYgKGRlYnVnUmVnZXggJiYgIXN0ci5tYXRjaChkZWJ1Z1JlZ2V4KSkgcmV0dXJuIG5vb3A7XG4gICAgaWYgKCF3aW5kb3cuY2hyb21lKSByZXR1cm4gbG9nZ2VyLmxvZy5iaW5kKGxvZ2dlciwgbXNnKTtcbiAgICByZXR1cm4gbG9nZ2VyLmxvZy5iaW5kKGxvZ2dlciwgbXNnLCBcImNvbG9yOiBoc2woXCIgKyAoeWllbGRDb2xvcigpKSArIFwiLDk5JSw0MCUpOyBmb250LXdlaWdodDogYm9sZFwiKTtcbiAgfTtcblxuICBib3dzLmNvbmZpZyA9IGZ1bmN0aW9uKGNvbmZpZykge1xuICAgIGlmIChjb25maWcucGFkTGVuZ3RoKSB7XG4gICAgICByZXR1cm4gcGFkTGVuZ3RoID0gY29uZmlnLnBhZExlbmd0aDtcbiAgICB9XG4gIH07XG5cbiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9kdWxlLmV4cG9ydHMgPSBib3dzO1xuICB9IGVsc2Uge1xuICAgIHdpbmRvdy5ib3dzID0gYm93cztcbiAgfVxufSkuY2FsbCgpO1xuIiwiLy8gZm9sbG93IEBIZW5yaWtKb3JldGVnIGFuZCBAYW5keWV0IGlmIHlvdSBsaWtlIHRoaXMgOylcbihmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGluTm9kZSA9IHR5cGVvZiB3aW5kb3cgPT09ICd1bmRlZmluZWQnLFxuICAgICAgICBscyA9ICFpbk5vZGUgJiYgd2luZG93LmxvY2FsU3RvcmFnZSxcbiAgICAgICAgb3V0ID0ge307XG5cbiAgICBpZiAoaW5Ob2RlKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gY29uc29sZTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChscyAmJiBscy5kZWJ1ZyAmJiB3aW5kb3cuY29uc29sZSkge1xuICAgICAgICBvdXQgPSB3aW5kb3cuY29uc29sZTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbWV0aG9kcyA9IFwiYXNzZXJ0LGNvdW50LGRlYnVnLGRpcixkaXJ4bWwsZXJyb3IsZXhjZXB0aW9uLGdyb3VwLGdyb3VwQ29sbGFwc2VkLGdyb3VwRW5kLGluZm8sbG9nLG1hcmtUaW1lbGluZSxwcm9maWxlLHByb2ZpbGVFbmQsdGltZSx0aW1lRW5kLHRyYWNlLHdhcm5cIi5zcGxpdChcIixcIiksXG4gICAgICAgICAgICBsID0gbWV0aG9kcy5sZW5ndGgsXG4gICAgICAgICAgICBmbiA9IGZ1bmN0aW9uICgpIHt9O1xuXG4gICAgICAgIHdoaWxlIChsLS0pIHtcbiAgICAgICAgICAgIG91dFttZXRob2RzW2xdXSA9IGZuO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZXhwb3J0cyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBvdXQ7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgd2luZG93LmNvbnNvbGUgPSBvdXQ7XG4gICAgfVxufSkoKTtcbiIsIi8vIGdldFVzZXJNZWRpYSBoZWxwZXIgYnkgQEhlbnJpa0pvcmV0ZWdcbnZhciBmdW5jID0gKG5hdmlnYXRvci5nZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci53ZWJraXRHZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci5tb3pHZXRVc2VyTWVkaWEgfHxcbiAgICAgICAgICAgIG5hdmlnYXRvci5tc0dldFVzZXJNZWRpYSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoY29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIG9wdGlvbnM7XG4gICAgdmFyIGhhdmVPcHRzID0gYXJndW1lbnRzLmxlbmd0aCA9PT0gMjtcbiAgICB2YXIgZGVmYXVsdE9wdHMgPSB7dmlkZW86IHRydWUsIGF1ZGlvOiB0cnVlfTtcbiAgICB2YXIgZXJyb3I7XG4gICAgdmFyIGRlbmllZCA9ICdQRVJNSVNTSU9OX0RFTklFRCc7XG4gICAgdmFyIG5vdFNhdGlmaWVkID0gJ0NPTlNUUkFJTlRfTk9UX1NBVElTRklFRCc7XG5cbiAgICAvLyBtYWtlIGNvbnN0cmFpbnRzIG9wdGlvbmFsXG4gICAgaWYgKCFoYXZlT3B0cykge1xuICAgICAgICBjYiA9IGNvbnN0cmFpbnRzO1xuICAgICAgICBjb25zdHJhaW50cyA9IGRlZmF1bHRPcHRzO1xuICAgIH1cblxuICAgIC8vIHRyZWF0IGxhY2sgb2YgYnJvd3NlciBzdXBwb3J0IGxpa2UgYW4gZXJyb3JcbiAgICBpZiAoIWZ1bmMpIHtcbiAgICAgICAgLy8gdGhyb3cgcHJvcGVyIGVycm9yIHBlciBzcGVjXG4gICAgICAgIGVycm9yID0gbmV3IEVycm9yKCdOYXZpZ2F0b3JVc2VyTWVkaWFFcnJvcicpO1xuICAgICAgICBlcnJvci5uYW1lID0gJ05PVF9TVVBQT1JURURfRVJST1InO1xuICAgICAgICByZXR1cm4gY2IoZXJyb3IpO1xuICAgIH1cblxuICAgIGZ1bmMuY2FsbChuYXZpZ2F0b3IsIGNvbnN0cmFpbnRzLCBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgICAgIGNiKG51bGwsIHN0cmVhbSk7XG4gICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICB2YXIgZXJyb3I7XG4gICAgICAgIC8vIGNvZXJjZSBpbnRvIGFuIGVycm9yIG9iamVjdCBzaW5jZSBGRiBnaXZlcyB1cyBhIHN0cmluZ1xuICAgICAgICAvLyB0aGVyZSBhcmUgb25seSB0d28gdmFsaWQgbmFtZXMgYWNjb3JkaW5nIHRvIHRoZSBzcGVjXG4gICAgICAgIC8vIHdlIGNvZXJjZSBhbGwgbm9uLWRlbmllZCB0byBcImNvbnN0cmFpbnQgbm90IHNhdGlzZmllZFwiLlxuICAgICAgICBpZiAodHlwZW9mIGVyciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGVycm9yID0gbmV3IEVycm9yKCdOYXZpZ2F0b3JVc2VyTWVkaWFFcnJvcicpO1xuICAgICAgICAgICAgaWYgKGVyciA9PT0gZGVuaWVkKSB7XG4gICAgICAgICAgICAgICAgZXJyb3IubmFtZSA9IGRlbmllZDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXJyb3IubmFtZSA9IG5vdFNhdGlmaWVkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gaWYgd2UgZ2V0IGFuIGVycm9yIG9iamVjdCBtYWtlIHN1cmUgJy5uYW1lJyBwcm9wZXJ0eSBpcyBzZXRcbiAgICAgICAgICAgIC8vIGFjY29yZGluZyB0byBzcGVjOiBodHRwOi8vZGV2LnczLm9yZy8yMDExL3dlYnJ0Yy9lZGl0b3IvZ2V0dXNlcm1lZGlhLmh0bWwjbmF2aWdhdG9ydXNlcm1lZGlhZXJyb3ItYW5kLW5hdmlnYXRvcnVzZXJtZWRpYWVycm9yY2FsbGJhY2tcbiAgICAgICAgICAgIGVycm9yID0gZXJyO1xuICAgICAgICAgICAgaWYgKCFlcnJvci5uYW1lKSB7XG4gICAgICAgICAgICAgICAgLy8gdGhpcyBpcyBsaWtlbHkgY2hyb21lIHdoaWNoXG4gICAgICAgICAgICAgICAgLy8gc2V0cyBhIHByb3BlcnR5IGNhbGxlZCBcIkVSUk9SX0RFTklFRFwiIG9uIHRoZSBlcnJvciBvYmplY3RcbiAgICAgICAgICAgICAgICAvLyBpZiBzbyB3ZSBtYWtlIHN1cmUgdG8gc2V0IGEgbmFtZVxuICAgICAgICAgICAgICAgIGlmIChlcnJvcltkZW5pZWRdKSB7XG4gICAgICAgICAgICAgICAgICAgIGVyci5uYW1lID0gZGVuaWVkO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGVyci5uYW1lID0gbm90U2F0aWZpZWQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY2IoZXJyb3IpO1xuICAgIH0pO1xufTtcbiIsInZhciBXaWxkRW1pdHRlciA9IHJlcXVpcmUoJ3dpbGRlbWl0dGVyJyk7XG5cbmZ1bmN0aW9uIGdldE1heFZvbHVtZSAoYW5hbHlzZXIsIGZmdEJpbnMpIHtcbiAgdmFyIG1heFZvbHVtZSA9IC1JbmZpbml0eTtcbiAgYW5hbHlzZXIuZ2V0RmxvYXRGcmVxdWVuY3lEYXRhKGZmdEJpbnMpO1xuXG4gIGZvcih2YXIgaT0wLCBpaT1mZnRCaW5zLmxlbmd0aDsgaSA8IGlpOyBpKyspIHtcbiAgICBpZiAoZmZ0Qmluc1tpXSA+IG1heFZvbHVtZSAmJiBmZnRCaW5zW2ldIDwgMCkge1xuICAgICAgbWF4Vm9sdW1lID0gZmZ0Qmluc1tpXTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIG1heFZvbHVtZTtcbn1cblxuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHN0cmVhbSwgb3B0aW9ucykge1xuICB2YXIgaGFya2VyID0gbmV3IFdpbGRFbWl0dGVyKCk7XG5cbiAgLy8gbWFrZSBpdCBub3QgYnJlYWsgaW4gbm9uLXN1cHBvcnRlZCBicm93c2Vyc1xuICBpZiAoIXdpbmRvdy53ZWJraXRBdWRpb0NvbnRleHQpIHJldHVybiBoYXJrZXI7XG5cbiAgLy9Db25maWdcbiAgdmFyIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9LFxuICAgICAgc21vb3RoaW5nID0gKG9wdGlvbnMuc21vb3RoaW5nIHx8IDAuNSksXG4gICAgICBpbnRlcnZhbCA9IChvcHRpb25zLmludGVydmFsIHx8IDEwMCksXG4gICAgICB0aHJlc2hvbGQgPSBvcHRpb25zLnRocmVzaG9sZCxcbiAgICAgIHBsYXkgPSBvcHRpb25zLnBsYXk7XG5cbiAgLy9TZXR1cCBBdWRpbyBDb250ZXh0XG4gIHZhciBhdWRpb0NvbnRleHQgPSBuZXcgd2Via2l0QXVkaW9Db250ZXh0KCk7XG4gIHZhciBzb3VyY2VOb2RlLCBmZnRCaW5zLCBhbmFseXNlcjtcblxuICBhbmFseXNlciA9IGF1ZGlvQ29udGV4dC5jcmVhdGVBbmFseXNlcigpO1xuICBhbmFseXNlci5mZnRTaXplID0gNTEyO1xuICBhbmFseXNlci5zbW9vdGhpbmdUaW1lQ29uc3RhbnQgPSBzbW9vdGhpbmc7XG4gIGZmdEJpbnMgPSBuZXcgRmxvYXQzMkFycmF5KGFuYWx5c2VyLmZmdFNpemUpO1xuXG4gIGlmIChzdHJlYW0uanF1ZXJ5KSBzdHJlYW0gPSBzdHJlYW1bMF07XG4gIGlmIChzdHJlYW0gaW5zdGFuY2VvZiBIVE1MQXVkaW9FbGVtZW50KSB7XG4gICAgLy9BdWRpbyBUYWdcbiAgICBzb3VyY2VOb2RlID0gYXVkaW9Db250ZXh0LmNyZWF0ZU1lZGlhRWxlbWVudFNvdXJjZShzdHJlYW0pO1xuICAgIGlmICh0eXBlb2YgcGxheSA9PT0gJ3VuZGVmaW5lZCcpIHBsYXkgPSB0cnVlO1xuICAgIHRocmVzaG9sZCA9IHRocmVzaG9sZCB8fCAtNjU7XG4gIH0gZWxzZSB7XG4gICAgLy9XZWJSVEMgU3RyZWFtXG4gICAgc291cmNlTm9kZSA9IGF1ZGlvQ29udGV4dC5jcmVhdGVNZWRpYVN0cmVhbVNvdXJjZShzdHJlYW0pO1xuICAgIHRocmVzaG9sZCA9IHRocmVzaG9sZCB8fCAtNDU7XG4gIH1cblxuICBzb3VyY2VOb2RlLmNvbm5lY3QoYW5hbHlzZXIpO1xuICBpZiAocGxheSkgYW5hbHlzZXIuY29ubmVjdChhdWRpb0NvbnRleHQuZGVzdGluYXRpb24pO1xuXG4gIGhhcmtlci5zcGVha2luZyA9IGZhbHNlO1xuXG4gIGhhcmtlci5zZXRUaHJlc2hvbGQgPSBmdW5jdGlvbih0KSB7XG4gICAgdGhyZXNob2xkID0gdDtcbiAgfTtcblxuICBoYXJrZXIuc2V0SW50ZXJ2YWwgPSBmdW5jdGlvbihpKSB7XG4gICAgaW50ZXJ2YWwgPSBpO1xuICB9O1xuXG4gIC8vIFBvbGwgdGhlIGFuYWx5c2VyIG5vZGUgdG8gZGV0ZXJtaW5lIGlmIHNwZWFraW5nXG4gIC8vIGFuZCBlbWl0IGV2ZW50cyBpZiBjaGFuZ2VkXG4gIHZhciBsb29wZXIgPSBmdW5jdGlvbigpIHtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGN1cnJlbnRWb2x1bWUgPSBnZXRNYXhWb2x1bWUoYW5hbHlzZXIsIGZmdEJpbnMpO1xuXG4gICAgICBoYXJrZXIuZW1pdCgndm9sdW1lX2NoYW5nZScsIGN1cnJlbnRWb2x1bWUsIHRocmVzaG9sZCk7XG5cbiAgICAgIGlmIChjdXJyZW50Vm9sdW1lID4gdGhyZXNob2xkKSB7XG4gICAgICAgIGlmICghaGFya2VyLnNwZWFraW5nKSB7XG4gICAgICAgICAgaGFya2VyLnNwZWFraW5nID0gdHJ1ZTtcbiAgICAgICAgICBoYXJrZXIuZW1pdCgnc3BlYWtpbmcnKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGhhcmtlci5zcGVha2luZykge1xuICAgICAgICAgIGhhcmtlci5zcGVha2luZyA9IGZhbHNlO1xuICAgICAgICAgIGhhcmtlci5lbWl0KCdzdG9wcGVkX3NwZWFraW5nJyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbG9vcGVyKCk7XG4gICAgfSwgaW50ZXJ2YWwpO1xuICB9O1xuICBsb29wZXIoKTtcblxuXG4gIHJldHVybiBoYXJrZXI7XG59XG4iLCJ2YXIgXyA9IHJlcXVpcmUoJ3VuZGVyc2NvcmUnKTtcbnZhciB3ZWJydGMgPSByZXF1aXJlKCd3ZWJydGNzdXBwb3J0Jyk7XG52YXIgUGVlckNvbm5lY3Rpb24gPSByZXF1aXJlKCdydGNwZWVyY29ubmVjdGlvbicpO1xudmFyIEppbmdsZUpTT04gPSByZXF1aXJlKCdzZHAtamluZ2xlLWpzb24nKTtcblxuXG5mdW5jdGlvbiBKaW5nbGVQZWVyQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKSB7XG4gICAgdGhpcy5zaWQgPSAnJztcbiAgICB0aGlzLnNkcFNlc3NJZCA9IERhdGUubm93KCk7XG4gICAgdGhpcy5pc0luaXRpYXRvciA9IHRydWU7XG5cbiAgICB0aGlzLmxvY2FsRGVzY3JpcHRpb24gPSB7Y29udGVudHM6IFtdfTtcbiAgICB0aGlzLnJlbW90ZURlc2NyaXB0aW9uID0ge2NvbnRlbnRzOiBbXX07XG5cbiAgICBQZWVyQ29ubmVjdGlvbi5jYWxsKHRoaXMsIGNvbmZpZywgY29uc3RyYWludHMpO1xufVxuXG5KaW5nbGVQZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKFBlZXJDb25uZWN0aW9uLnByb3RvdHlwZSwge1xuICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBKaW5nbGVQZWVyQ29ubmVjdGlvblxuICAgIH1cbn0pO1xuXG5cbi8vIEdlbmVyYXRlIGFuZCBlbWl0IGFuIG9mZmVyIHdpdGggdGhlIGdpdmVuIGNvbnN0cmFpbnRzXG5KaW5nbGVQZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUub2ZmZXIgPSBmdW5jdGlvbiAoY29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBoYXNDb25zdHJhaW50cyA9IGFyZ3VtZW50cy5sZW5ndGggPT09IDI7XG4gICAgdmFyIG1lZGlhQ29uc3RyYWludHMgPSBoYXNDb25zdHJhaW50cyA/IGNvbnN0cmFpbnRzIDoge1xuICAgICAgICAgICAgbWFuZGF0b3J5OiB7XG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiB0cnVlXG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgdmFyIGNhbGxiYWNrID0gaGFzQ29uc3RyYWludHMgPyBjYiA6IGNvbnN0cmFpbnRzO1xuXG4gICAgLy8gQWN0dWFsbHkgZ2VuZXJhdGUgdGhlIG9mZmVyXG4gICAgdGhpcy5wYy5jcmVhdGVPZmZlcihcbiAgICAgICAgZnVuY3Rpb24gKG9mZmVyKSB7XG4gICAgICAgICAgICBvZmZlci5zZHAgPSBzZWxmLl9hcHBseVNkcEhhY2sob2ZmZXIuc2RwKTtcbiAgICAgICAgICAgIHNlbGYucGMuc2V0TG9jYWxEZXNjcmlwdGlvbihvZmZlcik7XG4gICAgICAgICAgICB2YXIganNvbiA9IEppbmdsZUpTT04udG9TZXNzaW9uSlNPTihvZmZlci5zZHAsIHNlbGYuaXNJbml0aWF0b3IgPyAnaW5pdGlhdG9yJyA6ICdyZXNwb25kZXInKTtcbiAgICAgICAgICAgIGpzb24uc2lkID0gdGhpcy5zaWQ7XG4gICAgICAgICAgICBzZWxmLmxvY2FsRGVzY3JpcHRpb24gPSBqc29uO1xuICAgICAgICAgICAgdmFyIGV4cGFuZGVkT2ZmZXIgPSB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ29mZmVyJyxcbiAgICAgICAgICAgICAgICBzZHA6IG9mZmVyLnNkcCxcbiAgICAgICAgICAgICAgICBqc29uOiBqc29uXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdvZmZlcicsIGV4cGFuZGVkT2ZmZXIpO1xuICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSBjYWxsYmFjayhudWxsLCBleHBhbmRlZE9mZmVyKTtcbiAgICAgICAgfSxcbiAgICAgICAgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XG4gICAgICAgICAgICBpZiAoY2FsbGJhY2spIGNhbGxiYWNrKGVycik7XG4gICAgICAgIH0sXG4gICAgICAgIG1lZGlhQ29uc3RyYWludHNcbiAgICApO1xufTtcblxuXG4vLyBQcm9jZXNzIGFuIGFuc3dlclxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLmhhbmRsZUFuc3dlciA9IGZ1bmN0aW9uIChhbnN3ZXIsIGNiKSB7XG4gICAgY2IgPSBjYiB8fCBmdW5jdGlvbiAoKSB7fTtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgYW5zd2VyLnNkcCA9IEppbmdsZUpTT04udG9TZXNzaW9uU0RQKGFuc3dlci5qc29uLCB0aGlzLnNkcFNlc3NJZCk7XG4gICAgc2VsZi5yZW1vdGVEZXNjcmlwdGlvbiA9IGFuc3dlci5qc29uO1xuICAgIHRoaXMucGMuc2V0UmVtb3RlRGVzY3JpcHRpb24oXG4gICAgICAgIG5ldyB3ZWJydGMuU2Vzc2lvbkRlc2NyaXB0aW9uKGFuc3dlciksXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGNiKG51bGwpO1xuICAgICAgICB9LFxuICAgICAgICBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICAgICAgICBjYihlcnIpO1xuICAgICAgICB9XG4gICAgKTtcbn07XG5cbi8vIEludGVybmFsIGNvZGUgc2hhcmluZyBmb3IgdmFyaW91cyB0eXBlcyBvZiBhbnN3ZXIgbWV0aG9kc1xuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9hbnN3ZXIgPSBmdW5jdGlvbiAob2ZmZXIsIGNvbnN0cmFpbnRzLCBjYikge1xuICAgIGNiID0gY2IgfHwgZnVuY3Rpb24gKCkge307XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9mZmVyLnNkcCA9IEppbmdsZUpTT04udG9TZXNzaW9uU0RQKG9mZmVyLmpzb24sIHNlbGYuc2RwU2Vzc0lkKTtcbiAgICBzZWxmLnJlbW90ZURlc2NyaXB0aW9uID0gb2ZmZXIuanNvbjtcbiAgICB0aGlzLnBjLnNldFJlbW90ZURlc2NyaXB0aW9uKG5ldyB3ZWJydGMuU2Vzc2lvbkRlc2NyaXB0aW9uKG9mZmVyKSwgZnVuY3Rpb24gKCkge1xuICAgICAgICBzZWxmLnBjLmNyZWF0ZUFuc3dlcihcbiAgICAgICAgICAgIGZ1bmN0aW9uIChhbnN3ZXIpIHtcbiAgICAgICAgICAgICAgICBhbnN3ZXIuc2RwID0gc2VsZi5fYXBwbHlTZHBIYWNrKGFuc3dlci5zZHApO1xuICAgICAgICAgICAgICAgIHNlbGYucGMuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXIpO1xuICAgICAgICAgICAgICAgIHZhciBqc29uID0gSmluZ2xlSlNPTi50b1Nlc3Npb25KU09OKGFuc3dlci5zZHApO1xuICAgICAgICAgICAgICAgIGpzb24uc2lkID0gc2VsZi5zaWQ7XG4gICAgICAgICAgICAgICAgc2VsZi5sb2NhbERlc2NyaXB0aW9uID0ganNvbjtcbiAgICAgICAgICAgICAgICB2YXIgZXhwYW5kZWRBbnN3ZXIgPSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdhbnN3ZXInLFxuICAgICAgICAgICAgICAgICAgICBzZHA6IGFuc3dlci5zZHAsXG4gICAgICAgICAgICAgICAgICAgIGpzb246IGpzb25cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnYW5zd2VyJywgZXhwYW5kZWRBbnN3ZXIpO1xuICAgICAgICAgICAgICAgIGlmIChjYikgY2IobnVsbCwgZXhwYW5kZWRBbnN3ZXIpO1xuICAgICAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgICAgICAgICAgICAgIGlmIChjYikgY2IoZXJyKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBjb25zdHJhaW50c1xuICAgICAgICApO1xuICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgY2IoZXJyKTtcbiAgICB9KTtcbn07XG5cblxuLy8gSW5pdCBhbmQgYWRkIGljZSBjYW5kaWRhdGUgb2JqZWN0IHdpdGggY29ycmVjdCBjb25zdHJ1Y3RvclxuSmluZ2xlUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLnByb2Nlc3NJY2UgPSBmdW5jdGlvbiAodXBkYXRlLCBjYikge1xuICAgIGNiID0gY2IgfHwgZnVuY3Rpb24gKCkge307XG5cbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICB2YXIgY29udGVudE5hbWVzID0gXy5tYXAodGhpcy5yZW1vdGVEZXNjcmlwdGlvbi5jb250ZW50cywgZnVuY3Rpb24gKGNvbnRlbnQpIHtcbiAgICAgICAgcmV0dXJuIGNvbnRlbnQubmFtZTtcbiAgICB9KTtcblxuICAgIHZhciBjb250ZW50cyA9IHVwZGF0ZS5jb250ZW50cyB8fCBbXTtcbiAgICBjb250ZW50cy5mb3JFYWNoKGZ1bmN0aW9uIChjb250ZW50KSB7XG4gICAgICAgIHZhciB0cmFuc3BvcnQgPSBjb250ZW50LnRyYW5zcG9ydCB8fCB7fTtcbiAgICAgICAgdmFyIGNhbmRpZGF0ZXMgPSB0cmFuc3BvcnQuY2FuZGlkYXRlcyB8fCBbXTtcblxuICAgICAgICB2YXIgbWxpbmUgPSBjb250ZW50TmFtZXMuaW5kZXhPZihjb250ZW50Lm5hbWUpO1xuICAgICAgICB2YXIgbWlkID0gY29udGVudC5uYW1lO1xuXG4gICAgICAgIGNhbmRpZGF0ZXMuZm9yRWFjaChmdW5jdGlvbiAoY2FuZGlkYXRlKSB7XG4gICAgICAgICAgICB2YXIgaWNlQ2FuZGlkYXRlID0gSmluZ2xlSlNPTi50b0NhbmRpZGF0ZVNEUChjYW5kaWRhdGUpICsgJ1xcclxcbic7XG4gICAgICAgICAgICB2YXIgaWNlRGF0YSA9IHtcbiAgICAgICAgICAgICAgICBjYW5kaWRhdGU6IGljZUNhbmRpZGF0ZSxcbiAgICAgICAgICAgICAgICBzZHBNTGluZUluZGV4OiBtbGluZSxcbiAgICAgICAgICAgICAgICBzZHBNaWQ6IG1pZFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHNlbGYucGMuYWRkSWNlQ2FuZGlkYXRlKG5ldyB3ZWJydGMuSWNlQ2FuZGlkYXRlKGljZURhdGEpKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgY2IoKTtcbn07XG5cblxuLy8gSW50ZXJuYWwgbWV0aG9kIGZvciBlbWl0dGluZyBpY2UgY2FuZGlkYXRlcyBvbiBvdXIgcGVlciBvYmplY3RcbkppbmdsZVBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5fb25JY2UgPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKGV2ZW50LmNhbmRpZGF0ZSkge1xuICAgICAgICB2YXIgaWNlID0gZXZlbnQuY2FuZGlkYXRlO1xuICAgICAgICB0aGlzLmVtaXQoJ2ljZScsIHtcbiAgICAgICAgICAgIGNvbnRlbnRzOiBbe1xuICAgICAgICAgICAgICAgIG5hbWU6IGljZS5zZHBNaWQsXG4gICAgICAgICAgICAgICAgY3JlYXRvcjogc2VsZi5pc0luaXRpYXRvciA/ICdpbml0aWF0b3InIDogJ3Jlc3BvbmRlcicsXG4gICAgICAgICAgICAgICAgdHJhbnNwb3J0OiB7XG4gICAgICAgICAgICAgICAgICAgIHRyYW5zVHlwZTogJ2ljZVVkcCcsXG4gICAgICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgIEppbmdsZUpTT04udG9DYW5kaWRhdGVKU09OKGljZS5jYW5kaWRhdGUpXG4gICAgICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XVxuICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmVtaXQoJ2VuZE9mQ2FuZGlkYXRlcycpO1xuICAgIH1cbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBKaW5nbGVQZWVyQ29ubmVjdGlvbjtcbiIsInZhciBXaWxkRW1pdHRlciA9IHJlcXVpcmUoJ3dpbGRlbWl0dGVyJyk7XG52YXIgd2VicnRjID0gcmVxdWlyZSgnd2VicnRjc3VwcG9ydCcpO1xuXG5cbmZ1bmN0aW9uIFBlZXJDb25uZWN0aW9uKGNvbmZpZywgY29uc3RyYWludHMpIHtcbiAgICB2YXIgaXRlbTtcbiAgICB0aGlzLnBjID0gbmV3IHdlYnJ0Yy5QZWVyQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKTtcbiAgICBXaWxkRW1pdHRlci5jYWxsKHRoaXMpO1xuXG4gICAgLy8gcHJveHkgc29tZSBldmVudHMgZGlyZWN0bHlcbiAgICB0aGlzLnBjLm9ucmVtb3Zlc3RyZWFtID0gdGhpcy5lbWl0LmJpbmQodGhpcywgJ3JlbW92ZVN0cmVhbScpO1xuICAgIHRoaXMucGMub25uZWdvdGlhdGlvbm5lZWRlZCA9IHRoaXMuZW1pdC5iaW5kKHRoaXMsICduZWdvdGlhdGlvbk5lZWRlZCcpO1xuICAgIHRoaXMucGMub25pY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UgPSB0aGlzLmVtaXQuYmluZCh0aGlzLCAnaWNlQ29ubmVjdGlvblN0YXRlQ2hhbmdlJyk7XG4gICAgdGhpcy5wYy5vbnNpZ25hbGluZ3N0YXRlY2hhbmdlID0gdGhpcy5lbWl0LmJpbmQodGhpcywgJ3NpZ25hbGluZ1N0YXRlQ2hhbmdlJyk7XG5cbiAgICAvLyBoYW5kbGUgaW5jb21pbmcgaWNlIGFuZCBkYXRhIGNoYW5uZWwgZXZlbnRzXG4gICAgdGhpcy5wYy5vbmFkZHN0cmVhbSA9IHRoaXMuX29uQWRkU3RyZWFtLmJpbmQodGhpcyk7XG4gICAgdGhpcy5wYy5vbmljZWNhbmRpZGF0ZSA9IHRoaXMuX29uSWNlLmJpbmQodGhpcyk7XG4gICAgdGhpcy5wYy5vbmRhdGFjaGFubmVsID0gdGhpcy5fb25EYXRhQ2hhbm5lbC5iaW5kKHRoaXMpO1xuXG4gICAgLy8gd2hldGhlciB0byB1c2UgU0RQIGhhY2sgZm9yIGZhc3RlciBkYXRhIHRyYW5zZmVyXG4gICAgdGhpcy5jb25maWcgPSB7XG4gICAgICAgIGRlYnVnOiBmYWxzZSxcbiAgICAgICAgc2RwSGFjazogdHJ1ZVxuICAgIH07XG5cbiAgICAvLyBhcHBseSBvdXIgY29uZmlnXG4gICAgZm9yIChpdGVtIGluIGNvbmZpZykge1xuICAgICAgICB0aGlzLmNvbmZpZ1tpdGVtXSA9IGNvbmZpZ1tpdGVtXTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jb25maWcuZGVidWcpIHtcbiAgICAgICAgdGhpcy5vbignKicsIGZ1bmN0aW9uIChldmVudE5hbWUsIGV2ZW50KSB7XG4gICAgICAgICAgICB2YXIgbG9nZ2VyID0gY29uZmlnLmxvZ2dlciB8fCBjb25zb2xlO1xuICAgICAgICAgICAgbG9nZ2VyLmxvZygnUGVlckNvbm5lY3Rpb24gZXZlbnQ6JywgYXJndW1lbnRzKTtcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKFdpbGRFbWl0dGVyLnByb3RvdHlwZSwge1xuICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBQZWVyQ29ubmVjdGlvblxuICAgIH1cbn0pO1xuXG4vLyBBZGQgYSBzdHJlYW0gdG8gdGhlIHBlZXIgY29ubmVjdGlvbiBvYmplY3RcblBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5hZGRTdHJlYW0gPSBmdW5jdGlvbiAoc3RyZWFtKSB7XG4gICAgdGhpcy5sb2NhbFN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLnBjLmFkZFN0cmVhbShzdHJlYW0pO1xufTtcblxuXG4vLyBJbml0IGFuZCBhZGQgaWNlIGNhbmRpZGF0ZSBvYmplY3Qgd2l0aCBjb3JyZWN0IGNvbnN0cnVjdG9yXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUucHJvY2Vzc0ljZSA9IGZ1bmN0aW9uIChjYW5kaWRhdGUpIHtcbiAgICB0aGlzLnBjLmFkZEljZUNhbmRpZGF0ZShuZXcgd2VicnRjLkljZUNhbmRpZGF0ZShjYW5kaWRhdGUpKTtcbn07XG5cbi8vIEdlbmVyYXRlIGFuZCBlbWl0IGFuIG9mZmVyIHdpdGggdGhlIGdpdmVuIGNvbnN0cmFpbnRzXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUub2ZmZXIgPSBmdW5jdGlvbiAoY29uc3RyYWludHMsIGNiKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciBoYXNDb25zdHJhaW50cyA9IGFyZ3VtZW50cy5sZW5ndGggPT09IDI7XG4gICAgdmFyIG1lZGlhQ29uc3RyYWludHMgPSBoYXNDb25zdHJhaW50cyA/IGNvbnN0cmFpbnRzIDoge1xuICAgICAgICAgICAgbWFuZGF0b3J5OiB7XG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiB0cnVlXG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgdmFyIGNhbGxiYWNrID0gaGFzQ29uc3RyYWludHMgPyBjYiA6IGNvbnN0cmFpbnRzO1xuXG4gICAgLy8gQWN0dWFsbHkgZ2VuZXJhdGUgdGhlIG9mZmVyXG4gICAgdGhpcy5wYy5jcmVhdGVPZmZlcihcbiAgICAgICAgZnVuY3Rpb24gKG9mZmVyKSB7XG4gICAgICAgICAgICBvZmZlci5zZHAgPSBzZWxmLl9hcHBseVNkcEhhY2sob2ZmZXIuc2RwKTtcbiAgICAgICAgICAgIHNlbGYucGMuc2V0TG9jYWxEZXNjcmlwdGlvbihvZmZlcik7XG4gICAgICAgICAgICBzZWxmLmVtaXQoJ29mZmVyJywgb2ZmZXIpO1xuICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSBjYWxsYmFjayhudWxsLCBvZmZlcik7XG4gICAgICAgIH0sXG4gICAgICAgIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgICAgIHNlbGYuZW1pdCgnZXJyb3InLCBlcnIpO1xuICAgICAgICAgICAgaWYgKGNhbGxiYWNrKSBjYWxsYmFjayhlcnIpO1xuICAgICAgICB9LFxuICAgICAgICBtZWRpYUNvbnN0cmFpbnRzXG4gICAgKTtcbn07XG5cbi8vIEFuc3dlciBhbiBvZmZlciB3aXRoIGF1ZGlvIG9ubHlcblBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5hbnN3ZXJBdWRpb09ubHkgPSBmdW5jdGlvbiAob2ZmZXIsIGNiKSB7XG4gICAgdmFyIG1lZGlhQ29uc3RyYWludHMgPSB7XG4gICAgICAgICAgICBtYW5kYXRvcnk6IHtcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZUF1ZGlvOiB0cnVlLFxuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlVmlkZW86IGZhbHNlXG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgdGhpcy5fYW5zd2VyKG9mZmVyLCBtZWRpYUNvbnN0cmFpbnRzLCBjYik7XG59O1xuXG4vLyBBbnN3ZXIgYW4gb2ZmZXIgd2l0aG91dCBvZmZlcmluZyB0byByZWNpZXZlXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuYW5zd2VyQnJvYWRjYXN0T25seSA9IGZ1bmN0aW9uIChvZmZlciwgY2IpIHtcbiAgICB2YXIgbWVkaWFDb25zdHJhaW50cyA9IHtcbiAgICAgICAgICAgIG1hbmRhdG9yeToge1xuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlQXVkaW86IGZhbHNlLFxuICAgICAgICAgICAgICAgIE9mZmVyVG9SZWNlaXZlVmlkZW86IGZhbHNlXG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgdGhpcy5fYW5zd2VyKG9mZmVyLCBtZWRpYUNvbnN0cmFpbnRzLCBjYik7XG59O1xuXG4vLyBBbnN3ZXIgYW4gb2ZmZXIgd2l0aCBnaXZlbiBjb25zdHJhaW50cyBkZWZhdWx0IGlzIGF1ZGlvL3ZpZGVvXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuYW5zd2VyID0gZnVuY3Rpb24gKG9mZmVyLCBjb25zdHJhaW50cywgY2IpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIGhhc0NvbnN0cmFpbnRzID0gYXJndW1lbnRzLmxlbmd0aCA9PT0gMztcbiAgICB2YXIgY2FsbGJhY2sgPSBoYXNDb25zdHJhaW50cyA/IGNiIDogY29uc3RyYWludHM7XG4gICAgdmFyIG1lZGlhQ29uc3RyYWludHMgPSBoYXNDb25zdHJhaW50cyA/IGNvbnN0cmFpbnRzIDoge1xuICAgICAgICAgICAgbWFuZGF0b3J5OiB7XG4gICAgICAgICAgICAgICAgT2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZSxcbiAgICAgICAgICAgICAgICBPZmZlclRvUmVjZWl2ZVZpZGVvOiB0cnVlXG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG5cbiAgICB0aGlzLl9hbnN3ZXIob2ZmZXIsIG1lZGlhQ29uc3RyYWludHMsIGNhbGxiYWNrKTtcbn07XG5cbi8vIFByb2Nlc3MgYW4gYW5zd2VyXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuaGFuZGxlQW5zd2VyID0gZnVuY3Rpb24gKGFuc3dlcikge1xuICAgIHRoaXMucGMuc2V0UmVtb3RlRGVzY3JpcHRpb24obmV3IHdlYnJ0Yy5TZXNzaW9uRGVzY3JpcHRpb24oYW5zd2VyKSk7XG59O1xuXG4vLyBDbG9zZSB0aGUgcGVlciBjb25uZWN0aW9uXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5wYy5jbG9zZSgpO1xuICAgIHRoaXMuZW1pdCgnY2xvc2UnKTtcbn07XG5cbi8vIEludGVybmFsIGNvZGUgc2hhcmluZyBmb3IgdmFyaW91cyB0eXBlcyBvZiBhbnN3ZXIgbWV0aG9kc1xuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9hbnN3ZXIgPSBmdW5jdGlvbiAob2ZmZXIsIGNvbnN0cmFpbnRzLCBjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLnBjLnNldFJlbW90ZURlc2NyaXB0aW9uKG5ldyB3ZWJydGMuU2Vzc2lvbkRlc2NyaXB0aW9uKG9mZmVyKSk7XG4gICAgdGhpcy5wYy5jcmVhdGVBbnN3ZXIoXG4gICAgICAgIGZ1bmN0aW9uIChhbnN3ZXIpIHtcbiAgICAgICAgICAgIGFuc3dlci5zZHAgPSBzZWxmLl9hcHBseVNkcEhhY2soYW5zd2VyLnNkcCk7XG4gICAgICAgICAgICBzZWxmLnBjLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyKTtcbiAgICAgICAgICAgIHNlbGYuZW1pdCgnYW5zd2VyJywgYW5zd2VyKTtcbiAgICAgICAgICAgIGlmIChjYikgY2IobnVsbCwgYW5zd2VyKTtcbiAgICAgICAgfSwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgc2VsZi5lbWl0KCdlcnJvcicsIGVycik7XG4gICAgICAgICAgICBpZiAoY2IpIGNiKGVycik7XG4gICAgICAgIH0sXG4gICAgICAgIGNvbnN0cmFpbnRzXG4gICAgKTtcbn07XG5cbi8vIEludGVybmFsIG1ldGhvZCBmb3IgZW1pdHRpbmcgaWNlIGNhbmRpZGF0ZXMgb24gb3VyIHBlZXIgb2JqZWN0XG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuX29uSWNlID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgaWYgKGV2ZW50LmNhbmRpZGF0ZSkge1xuICAgICAgICB0aGlzLmVtaXQoJ2ljZScsIGV2ZW50LmNhbmRpZGF0ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5lbWl0KCdlbmRPZkNhbmRpZGF0ZXMnKTtcbiAgICB9XG59O1xuXG4vLyBJbnRlcm5hbCBtZXRob2QgZm9yIHByb2Nlc3NpbmcgYSBuZXcgZGF0YSBjaGFubmVsIGJlaW5nIGFkZGVkIGJ5IHRoZVxuLy8gb3RoZXIgcGVlci5cblBlZXJDb25uZWN0aW9uLnByb3RvdHlwZS5fb25EYXRhQ2hhbm5lbCA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIHRoaXMuZW1pdCgnYWRkQ2hhbm5lbCcsIGV2ZW50LmNoYW5uZWwpO1xufTtcblxuLy8gSW50ZXJuYWwgaGFuZGxpbmcgb2YgYWRkaW5nIHN0cmVhbVxuUGVlckNvbm5lY3Rpb24ucHJvdG90eXBlLl9vbkFkZFN0cmVhbSA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIHRoaXMucmVtb3RlU3RyZWFtID0gZXZlbnQuc3RyZWFtO1xuICAgIHRoaXMuZW1pdCgnYWRkU3RyZWFtJywgZXZlbnQpO1xufTtcblxuLy8gU0RQIGhhY2sgZm9yIGluY3JlYXNpbmcgQVMgKGFwcGxpY2F0aW9uIHNwZWNpZmljKSBkYXRhIHRyYW5zZmVyIHNwZWVkIGFsbG93ZWQgaW4gY2hyb21lXG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuX2FwcGx5U2RwSGFjayA9IGZ1bmN0aW9uIChzZHApIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLnNkcEhhY2spIHJldHVybiBzZHA7XG4gICAgdmFyIHBhcnRzID0gc2RwLnNwbGl0KCdiPUFTOjMwJyk7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMikge1xuICAgICAgICAvLyBpbmNyZWFzZSBtYXggZGF0YSB0cmFuc2ZlciBiYW5kd2lkdGggdG8gMTAwIE1icHNcbiAgICAgICAgcmV0dXJuIHBhcnRzWzBdICsgJ2I9QVM6MTAyNDAwJyArIHBhcnRzWzFdO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBzZHA7XG4gICAgfVxufTtcblxuLy8gQ3JlYXRlIGEgZGF0YSBjaGFubmVsIHNwZWMgcmVmZXJlbmNlOlxuLy8gaHR0cDovL2Rldi53My5vcmcvMjAxMS93ZWJydGMvZWRpdG9yL3dlYnJ0Yy5odG1sI2lkbC1kZWYtUlRDRGF0YUNoYW5uZWxJbml0XG5QZWVyQ29ubmVjdGlvbi5wcm90b3R5cGUuY3JlYXRlRGF0YUNoYW5uZWwgPSBmdW5jdGlvbiAobmFtZSwgb3B0cykge1xuICAgIG9wdHMgfHwgKG9wdHMgPSB7fSk7XG4gICAgdmFyIHJlbGlhYmxlID0gISFvcHRzLnJlbGlhYmxlO1xuICAgIHZhciBwcm90b2NvbCA9IG9wdHMucHJvdG9jb2wgfHwgJ3RleHQvcGxhaW4nO1xuICAgIHZhciBuZWdvdGlhdGVkID0gISEob3B0cy5uZWdvdGlhdGVkIHx8IG9wdHMucHJlc2V0KTtcbiAgICB2YXIgc2V0dGluZ3M7XG4gICAgdmFyIGNoYW5uZWw7XG4gICAgLy8gZmlyZWZveCBpcyBhIGJpdCBtb3JlIGZpbm5pY2t5XG4gICAgaWYgKHdlYnJ0Yy5wcmVmaXggPT09ICdtb3onKSB7XG4gICAgICAgIGlmIChyZWxpYWJsZSkge1xuICAgICAgICAgICAgc2V0dGluZ3MgPSB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2w6IHByb3RvY29sLFxuICAgICAgICAgICAgICAgIHByZXNldDogbmVnb3RpYXRlZCxcbiAgICAgICAgICAgICAgICBzdHJlYW06IG5hbWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZXR0aW5ncyA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIGNoYW5uZWwgPSB0aGlzLnBjLmNyZWF0ZURhdGFDaGFubmVsKG5hbWUsIHNldHRpbmdzKTtcbiAgICAgICAgY2hhbm5lbC5iaW5hcnlUeXBlID0gJ2Jsb2InO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChyZWxpYWJsZSkge1xuICAgICAgICAgICAgc2V0dGluZ3MgPSB7XG4gICAgICAgICAgICAgICAgcmVsaWFibGU6IHRydWVcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZXR0aW5ncyA9IHtyZWxpYWJsZTogZmFsc2V9O1xuICAgICAgICB9XG4gICAgICAgIGNoYW5uZWwgPSB0aGlzLnBjLmNyZWF0ZURhdGFDaGFubmVsKG5hbWUsIHNldHRpbmdzKTtcbiAgICB9XG4gICAgcmV0dXJuIGNoYW5uZWw7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFBlZXJDb25uZWN0aW9uO1xuIiwidmFyIHN1cHBvcnQgPSByZXF1aXJlKCd3ZWJydGNzdXBwb3J0Jyk7XG5cblxuZnVuY3Rpb24gR2FpbkNvbnRyb2xsZXIoc3RyZWFtKSB7XG4gICAgdGhpcy5zdXBwb3J0ID0gc3VwcG9ydC53ZWJBdWRpbyAmJiBzdXBwb3J0Lm1lZGlhU3RyZWFtO1xuXG4gICAgLy8gc2V0IG91ciBzdGFydGluZyB2YWx1ZVxuICAgIHRoaXMuZ2FpbiA9IDE7XG5cbiAgICBpZiAodGhpcy5zdXBwb3J0KSB7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5jb250ZXh0ID0gbmV3IHN1cHBvcnQuQXVkaW9Db250ZXh0KCk7XG4gICAgICAgIHRoaXMubWljcm9waG9uZSA9IGNvbnRleHQuY3JlYXRlTWVkaWFTdHJlYW1Tb3VyY2Uoc3RyZWFtKTtcbiAgICAgICAgdGhpcy5nYWluRmlsdGVyID0gY29udGV4dC5jcmVhdGVHYWluKCk7XG4gICAgICAgIHRoaXMuZGVzdGluYXRpb24gPSBjb250ZXh0LmNyZWF0ZU1lZGlhU3RyZWFtRGVzdGluYXRpb24oKTtcbiAgICAgICAgdGhpcy5vdXRwdXRTdHJlYW0gPSB0aGlzLmRlc3RpbmF0aW9uLnN0cmVhbTtcbiAgICAgICAgdGhpcy5taWNyb3Bob25lLmNvbm5lY3QodGhpcy5nYWluRmlsdGVyKTtcbiAgICAgICAgdGhpcy5nYWluRmlsdGVyLmNvbm5lY3QodGhpcy5kZXN0aW5hdGlvbik7XG4gICAgICAgIHN0cmVhbS5yZW1vdmVUcmFjayhzdHJlYW0uZ2V0QXVkaW9UcmFja3MoKVswXSk7XG4gICAgICAgIHN0cmVhbS5hZGRUcmFjayh0aGlzLm91dHB1dFN0cmVhbS5nZXRBdWRpb1RyYWNrcygpWzBdKTtcbiAgICB9XG4gICAgdGhpcy5zdHJlYW0gPSBzdHJlYW07XG59XG5cbi8vIHNldHRpbmdcbkdhaW5Db250cm9sbGVyLnByb3RvdHlwZS5zZXRHYWluID0gZnVuY3Rpb24gKHZhbCkge1xuICAgIC8vIGNoZWNrIGZvciBzdXBwb3J0XG4gICAgaWYgKCF0aGlzLnN1cHBvcnQpIHJldHVybjtcbiAgICB0aGlzLmdhaW5GaWx0ZXIuZ2Fpbi52YWx1ZSA9IHZhbDtcbiAgICB0aGlzLmdhaW4gPSB2YWw7XG59O1xuXG5HYWluQ29udHJvbGxlci5wcm90b3R5cGUuZ2V0R2FpbiA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5nYWluO1xufTtcblxuR2FpbkNvbnRyb2xsZXIucHJvdG90eXBlLm9mZiA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5zZXRHYWluKDApO1xufTtcblxuR2FpbkNvbnRyb2xsZXIucHJvdG90eXBlLm9uID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuc2V0R2FpbigxKTtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBHYWluQ29udHJvbGxlcjtcbiIsIi8vIGNyZWF0ZWQgYnkgQEhlbnJpa0pvcmV0ZWdcbnZhciBQQyA9IHdpbmRvdy5tb3pSVENQZWVyQ29ubmVjdGlvbiB8fCB3aW5kb3cud2Via2l0UlRDUGVlckNvbm5lY3Rpb24gfHwgd2luZG93LlJUQ1BlZXJDb25uZWN0aW9uO1xudmFyIEljZUNhbmRpZGF0ZSA9IHdpbmRvdy5tb3pSVENJY2VDYW5kaWRhdGUgfHwgd2luZG93LlJUQ0ljZUNhbmRpZGF0ZTtcbnZhciBTZXNzaW9uRGVzY3JpcHRpb24gPSB3aW5kb3cubW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8IHdpbmRvdy5SVENTZXNzaW9uRGVzY3JpcHRpb247XG52YXIgcHJlZml4ID0gZnVuY3Rpb24gKCkge1xuICAgIGlmICh3aW5kb3cubW96UlRDUGVlckNvbm5lY3Rpb24pIHtcbiAgICAgICAgcmV0dXJuICdtb3onO1xuICAgIH0gZWxzZSBpZiAod2luZG93LndlYmtpdFJUQ1BlZXJDb25uZWN0aW9uKSB7XG4gICAgICAgIHJldHVybiAnd2Via2l0JztcbiAgICB9XG59KCk7XG52YXIgTWVkaWFTdHJlYW0gPSB3aW5kb3cud2Via2l0TWVkaWFTdHJlYW0gfHwgd2luZG93Lk1lZGlhU3RyZWFtO1xudmFyIHNjcmVlblNoYXJpbmcgPSBuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKCdDaHJvbWUnKSAmJiBwYXJzZUludChuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKC9DaHJvbWVcXC8oLiopIC8pWzFdLCAxMCkgPj0gMjY7XG52YXIgQXVkaW9Db250ZXh0ID0gd2luZG93LndlYmtpdEF1ZGlvQ29udGV4dCB8fCB3aW5kb3cuQXVkaW9Db250ZXh0O1xuXG4vLyBleHBvcnQgc3VwcG9ydCBmbGFncyBhbmQgY29uc3RydWN0b3JzLnByb3RvdHlwZSAmJiBQQ1xubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgc3VwcG9ydDogISFQQyxcbiAgICBkYXRhQ2hhbm5lbDogISEoUEMgJiYgUEMucHJvdG90eXBlICYmIFBDLnByb3RvdHlwZS5jcmVhdGVEYXRhQ2hhbm5lbCksXG4gICAgcHJlZml4OiBwcmVmaXgsXG4gICAgd2ViQXVkaW86ICEhKEF1ZGlvQ29udGV4dCAmJiBBdWRpb0NvbnRleHQucHJvdG90eXBlLmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKSxcbiAgICBtZWRpYVN0cmVhbTogISEoTWVkaWFTdHJlYW0gJiYgTWVkaWFTdHJlYW0ucHJvdG90eXBlLnJlbW92ZVRyYWNrKSxcbiAgICBzY3JlZW5TaGFyaW5nOiBzY3JlZW5TaGFyaW5nLFxuICAgIEF1ZGlvQ29udGV4dDogQXVkaW9Db250ZXh0LFxuICAgIFBlZXJDb25uZWN0aW9uOiBQQyxcbiAgICBTZXNzaW9uRGVzY3JpcHRpb246IFNlc3Npb25EZXNjcmlwdGlvbixcbiAgICBJY2VDYW5kaWRhdGU6IEljZUNhbmRpZGF0ZVxufTtcbiIsInZhciBtZXRob2RzID0gXCJhc3NlcnQsY291bnQsZGVidWcsZGlyLGRpcnhtbCxlcnJvcixleGNlcHRpb24sZ3JvdXAsZ3JvdXBDb2xsYXBzZWQsZ3JvdXBFbmQsaW5mbyxsb2csbWFya1RpbWVsaW5lLHByb2ZpbGUscHJvZmlsZUVuZCx0aW1lLHRpbWVFbmQsdHJhY2Usd2FyblwiLnNwbGl0KFwiLFwiKTtcbnZhciBsID0gbWV0aG9kcy5sZW5ndGg7XG52YXIgZm4gPSBmdW5jdGlvbiAoKSB7fTtcbnZhciBtb2NrY29uc29sZSA9IHt9O1xuXG53aGlsZSAobC0tKSB7XG4gICAgbW9ja2NvbnNvbGVbbWV0aG9kc1tsXV0gPSBmbjtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBtb2NrY29uc29sZTtcbiIsInZhciB0b3NkcCA9IHJlcXVpcmUoJy4vbGliL3Rvc2RwJyk7XG52YXIgdG9qc29uID0gcmVxdWlyZSgnLi9saWIvdG9qc29uJyk7XG5cblxuZXhwb3J0cy50b1Nlc3Npb25TRFAgPSB0b3NkcC50b1Nlc3Npb25TRFA7XG5leHBvcnRzLnRvTWVkaWFTRFAgPSB0b3NkcC50b01lZGlhU0RQO1xuZXhwb3J0cy50b0NhbmRpZGF0ZVNEUCA9IHRvc2RwLnRvQ2FuZGlkYXRlU0RQO1xuXG5leHBvcnRzLnRvU2Vzc2lvbkpTT04gPSB0b2pzb24udG9TZXNzaW9uSlNPTjtcbmV4cG9ydHMudG9NZWRpYUpTT04gPSB0b2pzb24udG9NZWRpYUpTT047XG5leHBvcnRzLnRvQ2FuZGlkYXRlSlNPTiA9IHRvanNvbi50b0NhbmRpZGF0ZUpTT047XG4iLCJleHBvcnRzLmxpbmVzID0gZnVuY3Rpb24gKHNkcCkge1xuICAgIHJldHVybiBzZHAuc3BsaXQoJ1xcclxcbicpLmZpbHRlcihmdW5jdGlvbiAobGluZSkge1xuICAgICAgICByZXR1cm4gbGluZS5sZW5ndGggPiAwO1xuICAgIH0pO1xufTtcblxuZXhwb3J0cy5maW5kTGluZSA9IGZ1bmN0aW9uIChwcmVmaXgsIG1lZGlhTGluZXMsIHNlc3Npb25MaW5lcykge1xuICAgIHZhciBwcmVmaXhMZW5ndGggPSBwcmVmaXgubGVuZ3RoO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbWVkaWFMaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAobWVkaWFMaW5lc1tpXS5zdWJzdHIoMCwgcHJlZml4TGVuZ3RoKSA9PT0gcHJlZml4KSB7XG4gICAgICAgICAgICByZXR1cm4gbWVkaWFMaW5lc1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyBDb250aW51ZSBzZWFyY2hpbmcgaW4gcGFyZW50IHNlc3Npb24gc2VjdGlvblxuICAgIGlmICghc2Vzc2lvbkxpbmVzKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IHNlc3Npb25MaW5lcy5sZW5ndGg7IGorKykge1xuICAgICAgICBpZiAoc2Vzc2lvbkxpbmVzW2pdLnN1YnN0cigwLCBwcmVmaXhMZW5ndGgpID09PSBwcmVmaXgpIHtcbiAgICAgICAgICAgIHJldHVybiBzZXNzaW9uTGluZXNbal07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7XG59O1xuXG5leHBvcnRzLmZpbmRMaW5lcyA9IGZ1bmN0aW9uIChwcmVmaXgsIG1lZGlhTGluZXMsIHNlc3Npb25MaW5lcykge1xuICAgIHZhciByZXN1bHRzID0gW107XG4gICAgdmFyIHByZWZpeExlbmd0aCA9IHByZWZpeC5sZW5ndGg7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtZWRpYUxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChtZWRpYUxpbmVzW2ldLnN1YnN0cigwLCBwcmVmaXhMZW5ndGgpID09PSBwcmVmaXgpIHtcbiAgICAgICAgICAgIHJlc3VsdHMucHVzaChtZWRpYUxpbmVzW2ldKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggfHwgIXNlc3Npb25MaW5lcykge1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBzZXNzaW9uTGluZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgaWYgKHNlc3Npb25MaW5lc1tqXS5zdWJzdHIoMCwgcHJlZml4TGVuZ3RoKSA9PT0gcHJlZml4KSB7XG4gICAgICAgICAgICByZXN1bHRzLnB1c2goc2Vzc2lvbkxpbmVzW2pdKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbn07XG5cbmV4cG9ydHMubWxpbmUgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDIpLnNwbGl0KCcgJyk7XG4gICAgdmFyIHBhcnNlZCA9IHtcbiAgICAgICAgbWVkaWE6IHBhcnRzWzBdLFxuICAgICAgICBwb3J0OiBwYXJ0c1sxXSxcbiAgICAgICAgcHJvdG86IHBhcnRzWzJdLFxuICAgICAgICBmb3JtYXRzOiBbXVxuICAgIH07XG4gICAgZm9yICh2YXIgaSA9IDM7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAocGFydHNbaV0pIHtcbiAgICAgICAgICAgIHBhcnNlZC5mb3JtYXRzLnB1c2gocGFydHNbaV0pO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLnJ0cG1hcCA9IGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgdmFyIHBhcnRzID0gbGluZS5zdWJzdHIoOSkuc3BsaXQoJyAnKTtcbiAgICB2YXIgcGFyc2VkID0ge1xuICAgICAgICBpZDogcGFydHMuc2hpZnQoKVxuICAgIH07XG5cbiAgICBwYXJ0cyA9IHBhcnRzWzBdLnNwbGl0KCcvJyk7XG5cbiAgICBwYXJzZWQubmFtZSA9IHBhcnRzWzBdO1xuICAgIHBhcnNlZC5jbG9ja3JhdGUgPSBwYXJ0c1sxXTtcbiAgICBwYXJzZWQuY2hhbm5lbHMgPSBwYXJ0cy5sZW5ndGggPT0gMyA/IHBhcnRzWzJdIDogJzEnO1xuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLmZtdHAgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBrdiwga2V5LCB2YWx1ZTtcbiAgICB2YXIgcGFydHMgPSBsaW5lLnN1YnN0cihsaW5lLmluZGV4T2YoJyAnKSArIDEpLnNwbGl0KCc7Jyk7XG4gICAgdmFyIHBhcnNlZCA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAga3YgPSBwYXJ0c1tpXS5zcGxpdCgnPScpO1xuICAgICAgICBrZXkgPSBrdlswXS50cmltKCk7XG4gICAgICAgIHZhbHVlID0ga3ZbMV07XG4gICAgICAgIGlmIChrZXkgJiYgdmFsdWUpIHtcbiAgICAgICAgICAgIHBhcnNlZC5wdXNoKHtrZXk6IGtleSwgdmFsdWU6IHZhbHVlfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoa2V5KSB7XG4gICAgICAgICAgICBwYXJzZWQucHVzaCh7a2V5OiAnJywgdmFsdWU6IGtleX0pO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLmNyeXB0byA9IGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgdmFyIHBhcnRzID0gbGluZS5zdWJzdHIoOSkuc3BsaXQoJyAnKTtcbiAgICB2YXIgcGFyc2VkID0ge1xuICAgICAgICB0YWc6IHBhcnRzWzBdLFxuICAgICAgICBjaXBoZXJTdWl0ZTogcGFydHNbMV0sXG4gICAgICAgIGtleVBhcmFtczogcGFydHNbMl0sXG4gICAgICAgIHNlc3Npb25QYXJhbXM6IHBhcnRzLnNsaWNlKDMpLmpvaW4oJyAnKVxuICAgIH07XG4gICAgcmV0dXJuIHBhcnNlZDtcbn07XG5cbmV4cG9ydHMuZmluZ2VycHJpbnQgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDE0KS5zcGxpdCgnICcpO1xuICAgIHJldHVybiB7XG4gICAgICAgIGhhc2g6IHBhcnRzWzBdLFxuICAgICAgICB2YWx1ZTogcGFydHNbMV1cbiAgICB9O1xufTtcblxuZXhwb3J0cy5leHRtYXAgPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBwYXJ0cyA9IGxpbmUuc3Vic3RyKDkpLnNwbGl0KCcgJyk7XG4gICAgdmFyIHBhcnNlZCA9IHt9O1xuXG4gICAgdmFyIGlkcGFydCA9IHBhcnRzLnNoaWZ0KCk7XG4gICAgdmFyIHNwID0gaWRwYXJ0LmluZGV4T2YoJy8nKTtcbiAgICBpZiAoc3AgPj0gMCkge1xuICAgICAgICBwYXJzZWQuaWQgPSBpZHBhcnQuc3Vic3RyKDAsIHNwKTtcbiAgICAgICAgcGFyc2VkLnNlbmRlcnMgPSBpZHBhcnQuc3Vic3RyKHNwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBwYXJzZWQuaWQgPSBpZHBhcnQ7XG4gICAgICAgIHBhcnNlZC5zZW5kZXJzID0gJ3NlbmRyZWN2JztcbiAgICB9XG5cbiAgICBwYXJzZWQudXJpID0gcGFydHMuc2hpZnQoKTtcblxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLnJ0Y3BmYiA9IGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgdmFyIHBhcnRzID0gbGluZS5zdWJzdHIoMTApLnNwbGl0KCcgJyk7XG4gICAgdmFyIHBhcnNlZCA9IHt9O1xuICAgIHBhcnNlZC5pZCA9IHBhcnRzLnNoaWZ0KCk7XG4gICAgcGFyc2VkLnR5cGUgPSBwYXJ0cy5zaGlmdCgpO1xuICAgIGlmIChwYXJzZWQudHlwZSA9PT0gJ3Ryci1pbnQnKSB7XG4gICAgICAgIHBhcnNlZC52YWx1ZSA9IHBhcnRzLnNoaWZ0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcGFyc2VkLnN1YnR5cGUgPSBwYXJ0cy5zaGlmdCgpO1xuICAgIH1cbiAgICBwYXJzZWQucGFyYW1ldGVycyA9IHBhcnRzO1xuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLmNhbmRpZGF0ZSA9IGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgdmFyIHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTIpLnNwbGl0KCcgJyk7XG5cbiAgICB2YXIgY2FuZGlkYXRlID0ge1xuICAgICAgICBmb3VuZGF0aW9uOiBwYXJ0c1swXSxcbiAgICAgICAgY29tcG9uZW50OiBwYXJ0c1sxXSxcbiAgICAgICAgcHJvdG9jb2w6IHBhcnRzWzJdLnRvTG93ZXJDYXNlKCksXG4gICAgICAgIHByaW9yaXR5OiBwYXJ0c1szXSxcbiAgICAgICAgaXA6IHBhcnRzWzRdLFxuICAgICAgICBwb3J0OiBwYXJ0c1s1XSxcbiAgICAgICAgLy8gc2tpcCBwYXJ0c1s2XSA9PSAndHlwJ1xuICAgICAgICB0eXBlOiBwYXJ0c1s3XVxuICAgIH07XG5cbiAgICBmb3IgKHZhciBpID0gODsgaSA8IHBhcnRzLmxlbmd0aDsgaSArPSAyKSB7XG4gICAgICAgIGlmIChwYXJ0c1tpXSA9PT0gJ3JhZGRyJykge1xuICAgICAgICAgICAgY2FuZGlkYXRlLnJlbEFkZHIgPSBwYXJ0c1tpICsgMV07XG4gICAgICAgIH0gZWxzZSBpZiAocGFydHNbaV0gPT09ICdycG9ydCcpIHtcbiAgICAgICAgICAgIGNhbmRpZGF0ZS5yZWxQb3J0ID0gcGFydHNbaSArIDFdO1xuICAgICAgICB9IGVsc2UgaWYgKHBhcnRzW2ldID09PSAnZ2VuZXJhdGlvbicpIHtcbiAgICAgICAgICAgIGNhbmRpZGF0ZS5nZW5lcmF0aW9uID0gcGFydHNbaSArIDFdO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY2FuZGlkYXRlLm5ldHdvcmsgPSAnMSc7XG5cbiAgICByZXR1cm4gY2FuZGlkYXRlO1xufTtcblxuZXhwb3J0cy5zc3JjID0gZnVuY3Rpb24gKGxpbmVzKSB7XG4gICAgLy8gaHR0cDovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjNTU3NlxuICAgIHZhciBwYXJzZWQgPSBbXTtcbiAgICB2YXIgcGVyc3NyYyA9IHt9O1xuICAgIHZhciBwYXJ0cztcbiAgICB2YXIgc3NyYztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHBhcnRzID0gbGluZXNbaV0uc3Vic3RyKDcpLnNwbGl0KCcgJyk7XG4gICAgICAgIHNzcmMgPSBwYXJ0cy5zaGlmdCgpO1xuICAgICAgICBwYXJ0cyA9IHBhcnRzLmpvaW4oJyAnKS5zcGxpdCgnOicpO1xuICAgICAgICB2YXIgYXR0cmlidXRlID0gcGFydHMuc2hpZnQoKTtcbiAgICAgICAgdmFyIHZhbHVlID0gcGFydHMuam9pbignOicpIHx8IG51bGw7XG4gICAgICAgIGlmICghcGVyc3NyY1tzc3JjXSkgcGVyc3NyY1tzc3JjXSA9IHt9O1xuICAgICAgICBwZXJzc3JjW3NzcmNdW2F0dHJpYnV0ZV0gPSB2YWx1ZTtcbiAgICB9XG4gICAgZm9yIChzc3JjIGluIHBlcnNzcmMpIHtcbiAgICAgICAgdmFyIGl0ZW0gPSBwZXJzc3JjW3NzcmNdO1xuICAgICAgICBpdGVtLnNzcmMgPSBzc3JjO1xuICAgICAgICBwYXJzZWQucHVzaChpdGVtKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZDtcbn07XG5cbmV4cG9ydHMuZ3JvdXBpbmcgPSBmdW5jdGlvbiAobGluZXMpIHtcbiAgICAvLyBodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmM1ODg4XG4gICAgdmFyIHBhcnNlZCA9IFtdO1xuICAgIHZhciBwYXJ0cztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHBhcnRzID0gbGluZXNbaV0uc3Vic3RyKDgpLnNwbGl0KCcgJyk7XG4gICAgICAgIHBhcnNlZC5wdXNoKHtcbiAgICAgICAgICAgIHNlbWFudGljczogcGFydHMuc2hpZnQoKSxcbiAgICAgICAgICAgIGNvbnRlbnRzOiBwYXJ0c1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZDtcbn07XG4iLCJ2YXIgcGFyc2VycyA9IHJlcXVpcmUoJy4vcGFyc2VycycpO1xudmFyIGlkQ291bnRlciA9IE1hdGgucmFuZG9tKCk7XG5cblxuZXhwb3J0cy50b1Nlc3Npb25KU09OID0gZnVuY3Rpb24gKHNkcCwgY3JlYXRvcikge1xuICAgIC8vIERpdmlkZSB0aGUgU0RQIGludG8gc2Vzc2lvbiBhbmQgbWVkaWEgc2VjdGlvbnMuXG4gICAgdmFyIG1lZGlhID0gc2RwLnNwbGl0KCdcXHJcXG5tPScpO1xuICAgIGZvciAodmFyIGkgPSAxOyBpIDwgbWVkaWEubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgbWVkaWFbaV0gPSAnbT0nICsgbWVkaWFbaV07XG4gICAgICAgIGlmIChpICE9PSBtZWRpYS5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgICBtZWRpYVtpXSArPSAnXFxyXFxuJztcbiAgICAgICAgfVxuICAgIH1cbiAgICB2YXIgc2Vzc2lvbiA9IG1lZGlhLnNoaWZ0KCkgKyAnXFxyXFxuJztcbiAgICB2YXIgc2Vzc2lvbkxpbmVzID0gcGFyc2Vycy5saW5lcyhzZXNzaW9uKTtcbiAgICB2YXIgcGFyc2VkID0ge307XG5cbiAgICB2YXIgY29udGVudHMgPSBbXTtcbiAgICBtZWRpYS5mb3JFYWNoKGZ1bmN0aW9uIChtKSB7XG4gICAgICAgIGNvbnRlbnRzLnB1c2goZXhwb3J0cy50b01lZGlhSlNPTihtLCBzZXNzaW9uLCBjcmVhdG9yKSk7XG4gICAgfSk7XG4gICAgcGFyc2VkLmNvbnRlbnRzID0gY29udGVudHM7XG5cbiAgICB2YXIgZ3JvdXBMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPWdyb3VwOicsIHNlc3Npb25MaW5lcyk7XG4gICAgaWYgKGdyb3VwTGluZXMubGVuZ3RoKSB7XG4gICAgICAgIHBhcnNlZC5ncm91cGluZ3MgPSBwYXJzZXJzLmdyb3VwaW5nKGdyb3VwTGluZXMpO1xuICAgIH1cblxuICAgIHJldHVybiBwYXJzZWQ7XG59O1xuXG5leHBvcnRzLnRvTWVkaWFKU09OID0gZnVuY3Rpb24gKG1lZGlhLCBzZXNzaW9uLCBjcmVhdG9yKSB7XG4gICAgdmFyIGxpbmVzID0gcGFyc2Vycy5saW5lcyhtZWRpYSk7XG4gICAgdmFyIHNlc3Npb25MaW5lcyA9IHBhcnNlcnMubGluZXMoc2Vzc2lvbik7XG4gICAgdmFyIG1saW5lID0gcGFyc2Vycy5tbGluZShsaW5lc1swXSk7XG5cbiAgICB2YXIgY29udGVudCA9IHtcbiAgICAgICAgY3JlYXRvcjogY3JlYXRvcixcbiAgICAgICAgbmFtZTogbWxpbmUubWVkaWEsXG4gICAgICAgIGRlc2NyaXB0aW9uOiB7XG4gICAgICAgICAgICBkZXNjVHlwZTogJ3J0cCcsXG4gICAgICAgICAgICBtZWRpYTogbWxpbmUubWVkaWEsXG4gICAgICAgICAgICBwYXlsb2FkczogW10sXG4gICAgICAgICAgICBlbmNyeXB0aW9uOiBbXSxcbiAgICAgICAgICAgIGZlZWRiYWNrOiBbXSxcbiAgICAgICAgICAgIGhlYWRlckV4dGVuc2lvbnM6IFtdXG4gICAgICAgIH0sXG4gICAgICAgIHRyYW5zcG9ydDoge1xuICAgICAgICAgICAgdHJhbnNUeXBlOiAnaWNlVWRwJyxcbiAgICAgICAgICAgIGNhbmRpZGF0ZXM6IFtdLFxuICAgICAgICAgICAgZmluZ2VycHJpbnRzOiBbXVxuICAgICAgICB9XG4gICAgfTtcbiAgICB2YXIgZGVzYyA9IGNvbnRlbnQuZGVzY3JpcHRpb247XG4gICAgdmFyIHRyYW5zID0gY29udGVudC50cmFuc3BvcnQ7XG5cbiAgICB2YXIgc3NyYyA9IHBhcnNlcnMuZmluZExpbmUoJ2E9c3NyYzonLCBsaW5lcyk7XG4gICAgaWYgKHNzcmMpIHtcbiAgICAgICAgZGVzYy5zc3JjID0gc3NyYy5zdWJzdHIoNykuc3BsaXQoJyAnKVswXTtcbiAgICB9XG5cbiAgICAvLyBJZiB3ZSBoYXZlIGEgbWlkLCB1c2UgdGhhdCBmb3IgdGhlIGNvbnRlbnQgbmFtZSBpbnN0ZWFkLlxuICAgIHZhciBtaWQgPSBwYXJzZXJzLmZpbmRMaW5lKCdhPW1pZDonLCBsaW5lcyk7XG4gICAgaWYgKG1pZCkge1xuICAgICAgICBjb250ZW50Lm5hbWUgPSBtaWQuc3Vic3RyKDYpO1xuICAgIH1cblxuICAgIGlmIChwYXJzZXJzLmZpbmRMaW5lKCdhPXNlbmRyZWN2JywgbGluZXMsIHNlc3Npb25MaW5lcykpIHtcbiAgICAgICAgY29udGVudC5zZW5kZXJzID0gJ2JvdGgnO1xuICAgIH0gZWxzZSBpZiAocGFyc2Vycy5maW5kTGluZSgnYT1zZW5kb25seScsIGxpbmVzLCBzZXNzaW9uTGluZXMpKSB7XG4gICAgICAgIGNvbnRlbnQuc2VuZGVycyA9ICdpbml0aWF0b3InO1xuICAgIH0gZWxzZSBpZiAocGFyc2Vycy5maW5kTGluZSgnYT1yZWN2b25seScsIGxpbmVzLCBzZXNzaW9uTGluZXMpKSB7XG4gICAgICAgIGNvbnRlbnQuc2VuZGVycyA9ICdyZXNwb25kZXInO1xuICAgIH0gZWxzZSBpZiAocGFyc2Vycy5maW5kTGluZSgnYT1pbmFjdGl2ZScsIGxpbmVzLCBzZXNzaW9uTGluZXMpKSB7XG4gICAgICAgIGNvbnRlbnQuc2VuZGVycyA9ICdub25lJztcbiAgICB9XG5cbiAgICB2YXIgcnRwbWFwTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1ydHBtYXA6JywgbGluZXMpO1xuICAgIHJ0cG1hcExpbmVzLmZvckVhY2goZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgdmFyIHBheWxvYWQgPSBwYXJzZXJzLnJ0cG1hcChsaW5lKTtcbiAgICAgICAgcGF5bG9hZC5mZWVkYmFjayA9IFtdO1xuXG4gICAgICAgIHZhciBmbXRwTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1mbXRwOicgKyBwYXlsb2FkLmlkLCBsaW5lcyk7XG4gICAgICAgIGZtdHBMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICBwYXlsb2FkLnBhcmFtZXRlcnMgPSBwYXJzZXJzLmZtdHAobGluZSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHZhciBmYkxpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9cnRjcC1mYjonICsgcGF5bG9hZC5pZCwgbGluZXMpO1xuICAgICAgICBmYkxpbmVzLmZvckVhY2goZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgIHBheWxvYWQuZmVlZGJhY2sucHVzaChwYXJzZXJzLnJ0Y3BmYihsaW5lKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGRlc2MucGF5bG9hZHMucHVzaChwYXlsb2FkKTtcbiAgICB9KTtcblxuICAgIHZhciBjcnlwdG9MaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPWNyeXB0bzonLCBsaW5lcywgc2Vzc2lvbkxpbmVzKTtcbiAgICBjcnlwdG9MaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIGRlc2MuZW5jcnlwdGlvbi5wdXNoKHBhcnNlcnMuY3J5cHRvKGxpbmUpKTtcbiAgICB9KTtcblxuICAgIGlmIChwYXJzZXJzLmZpbmRMaW5lKCdhPXJ0Y3AtbXV4JywgbGluZXMpKSB7XG4gICAgICAgIGRlc2MubXV4ID0gdHJ1ZTtcbiAgICB9XG5cbiAgICB2YXIgZmJMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPXJ0Y3AtZmI6KicsIGxpbmVzKTtcbiAgICBmYkxpbmVzLmZvckVhY2goZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgZGVzYy5mZWVkYmFjay5wdXNoKHBhcnNlcnMucnRjcGZiKGxpbmUpKTtcbiAgICB9KTtcblxuICAgIHZhciBleHRMaW5lcyA9IHBhcnNlcnMuZmluZExpbmVzKCdhPWV4dG1hcDonLCBsaW5lcyk7XG4gICAgZXh0TGluZXMuZm9yRWFjaChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICB2YXIgZXh0ID0gcGFyc2Vycy5leHRtYXAobGluZSk7XG5cbiAgICAgICAgdmFyIHNlbmRlcnMgPSB7XG4gICAgICAgICAgICBzZW5kb25seTogJ3Jlc3BvbmRlcicsXG4gICAgICAgICAgICByZWN2b25seTogJ2luaXRpYXRvcicsXG4gICAgICAgICAgICBzZW5kcmVjdjogJ2JvdGgnLFxuICAgICAgICAgICAgaW5hY3RpdmU6ICdub25lJ1xuICAgICAgICB9O1xuICAgICAgICBleHQuc2VuZGVycyA9IHNlbmRlcnNbZXh0LnNlbmRlcnNdO1xuXG4gICAgICAgIGRlc2MuaGVhZGVyRXh0ZW5zaW9ucy5wdXNoKGV4dCk7XG4gICAgfSk7XG5cbiAgICB2YXIgc3NyY0xpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9c3NyYzonLCBsaW5lcyk7XG4gICAgaWYgKHNzcmNMaW5lcy5sZW5ndGgpIHtcbiAgICAgICAgZGVzYy5zc3JjcyA9IHBhcnNlcnMuc3NyYyhzc3JjTGluZXMpO1xuICAgIH1cblxuICAgIHZhciBmaW5nZXJwcmludExpbmVzID0gcGFyc2Vycy5maW5kTGluZXMoJ2E9ZmluZ2VycHJpbnQ6JywgbGluZXMsIHNlc3Npb25MaW5lcyk7XG4gICAgZmluZ2VycHJpbnRMaW5lcy5mb3JFYWNoKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgIHRyYW5zLmZpbmdlcnByaW50cy5wdXNoKHBhcnNlcnMuZmluZ2VycHJpbnQobGluZSkpO1xuICAgIH0pO1xuXG4gICAgdmFyIHVmcmFnTGluZSA9IHBhcnNlcnMuZmluZExpbmUoJ2E9aWNlLXVmcmFnOicsIGxpbmVzLCBzZXNzaW9uTGluZXMpO1xuICAgIHZhciBwd2RMaW5lID0gcGFyc2Vycy5maW5kTGluZSgnYT1pY2UtcHdkOicsIGxpbmVzLCBzZXNzaW9uTGluZXMpO1xuICAgIGlmICh1ZnJhZ0xpbmUgJiYgcHdkTGluZSkge1xuICAgICAgICB0cmFucy51ZnJhZyA9IHVmcmFnTGluZS5zdWJzdHIoMTIpO1xuICAgICAgICB0cmFucy5wd2QgPSBwd2RMaW5lLnN1YnN0cigxMCk7XG4gICAgICAgIHRyYW5zLmNhbmRpZGF0ZXMgPSBbXTtcblxuICAgICAgICB2YXIgY2FuZGlkYXRlTGluZXMgPSBwYXJzZXJzLmZpbmRMaW5lcygnYT1jYW5kaWRhdGU6JywgbGluZXMsIHNlc3Npb25MaW5lcyk7XG4gICAgICAgIGNhbmRpZGF0ZUxpbmVzLmZvckVhY2goZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgIHRyYW5zLmNhbmRpZGF0ZXMucHVzaChleHBvcnRzLnRvQ2FuZGlkYXRlSlNPTihsaW5lKSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBjb250ZW50O1xufTtcblxuZXhwb3J0cy50b0NhbmRpZGF0ZUpTT04gPSBmdW5jdGlvbiAobGluZSkge1xuICAgIHZhciBjYW5kaWRhdGUgPSBwYXJzZXJzLmNhbmRpZGF0ZShsaW5lLnNwbGl0KCdcXHJcXG4nKVswXSk7XG4gICAgY2FuZGlkYXRlLmlkID0gKGlkQ291bnRlcisrKS50b1N0cmluZygzNikuc3Vic3RyKDAsIDEyKTtcbiAgICByZXR1cm4gY2FuZGlkYXRlO1xufTtcbiIsInZhciBzZW5kZXJzID0ge1xuICAgICdpbml0aWF0b3InOiAnc2VuZG9ubHknLFxuICAgICdyZXNwb25kZXInOiAncmVjdm9ubHknLFxuICAgICdib3RoJzogJ3NlbmRyZWN2JyxcbiAgICAnbm9uZSc6ICdpbmFjdGl2ZScsXG4gICAgJ3NlbmRvbmx5JzogJ2luaXRhdG9yJyxcbiAgICAncmVjdm9ubHknOiAncmVzcG9uZGVyJyxcbiAgICAnc2VuZHJlY3YnOiAnYm90aCcsXG4gICAgJ2luYWN0aXZlJzogJ25vbmUnXG59O1xuXG5cbmV4cG9ydHMudG9TZXNzaW9uU0RQID0gZnVuY3Rpb24gKHNlc3Npb24sIHNpZCkge1xuICAgIHZhciBzZHAgPSBbXG4gICAgICAgICd2PTAnLFxuICAgICAgICAnbz0tICcgKyAoc2lkIHx8IHNlc3Npb24uc2lkIHx8IERhdGUubm93KCkpICsgJyAnICsgRGF0ZS5ub3coKSArICcgSU4gSVA0IDAuMC4wLjAnLFxuICAgICAgICAncz0tJyxcbiAgICAgICAgJ3Q9MCAwJ1xuICAgIF07XG5cbiAgICB2YXIgZ3JvdXBpbmdzID0gc2Vzc2lvbi5ncm91cGluZ3MgfHwgW107XG4gICAgZ3JvdXBpbmdzLmZvckVhY2goZnVuY3Rpb24gKGdyb3VwaW5nKSB7XG4gICAgICAgIHNkcC5wdXNoKCdhPWdyb3VwOicgKyBncm91cGluZy5zZW1hbnRpY3MgKyAnICcgKyBncm91cGluZy5jb250ZW50cy5qb2luKCcgJykpO1xuICAgIH0pO1xuXG4gICAgdmFyIGNvbnRlbnRzID0gc2Vzc2lvbi5jb250ZW50cyB8fCBbXTtcbiAgICBjb250ZW50cy5mb3JFYWNoKGZ1bmN0aW9uIChjb250ZW50KSB7XG4gICAgICAgIHNkcC5wdXNoKGV4cG9ydHMudG9NZWRpYVNEUChjb250ZW50KSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gc2RwLmpvaW4oJ1xcclxcbicpICsgJ1xcclxcbic7XG59O1xuXG5leHBvcnRzLnRvTWVkaWFTRFAgPSBmdW5jdGlvbiAoY29udGVudCkge1xuICAgIHZhciBzZHAgPSBbXTtcblxuICAgIHZhciBkZXNjID0gY29udGVudC5kZXNjcmlwdGlvbjtcbiAgICB2YXIgdHJhbnNwb3J0ID0gY29udGVudC50cmFuc3BvcnQ7XG4gICAgdmFyIHBheWxvYWRzID0gZGVzYy5wYXlsb2FkcyB8fCBbXTtcbiAgICB2YXIgZmluZ2VycHJpbnRzID0gKHRyYW5zcG9ydCAmJiB0cmFuc3BvcnQuZmluZ2VycHJpbnRzKSB8fCBbXTtcblxuICAgIHZhciBtbGluZSA9IFtkZXNjLm1lZGlhLCAnMSddO1xuXG4gICAgaWYgKChkZXNjLmVuY3J5cHRpb24gJiYgZGVzYy5lbmNyeXB0aW9uLmxlbmd0aCA+IDApIHx8IChmaW5nZXJwcmludHMubGVuZ3RoID4gMCkpIHtcbiAgICAgICAgbWxpbmUucHVzaCgnUlRQL1NBVlBGJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbWxpbmUucHVzaCgnUlRQL0FWUEYnKTtcbiAgICB9XG4gICAgcGF5bG9hZHMuZm9yRWFjaChmdW5jdGlvbiAocGF5bG9hZCkge1xuICAgICAgICBtbGluZS5wdXNoKHBheWxvYWQuaWQpO1xuICAgIH0pO1xuXG5cbiAgICBzZHAucHVzaCgnbT0nICsgbWxpbmUuam9pbignICcpKTtcblxuICAgIHNkcC5wdXNoKCdjPUlOIElQNCAwLjAuMC4wJyk7XG4gICAgc2RwLnB1c2goJ2E9cnRjcDoxIElOIElQNCAwLjAuMC4wJyk7XG5cbiAgICBpZiAodHJhbnNwb3J0KSB7XG4gICAgICAgIGlmICh0cmFuc3BvcnQudWZyYWcpIHtcbiAgICAgICAgICAgIHNkcC5wdXNoKCdhPWljZS11ZnJhZzonICsgdHJhbnNwb3J0LnVmcmFnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHJhbnNwb3J0LnB3ZCkge1xuICAgICAgICAgICAgc2RwLnB1c2goJ2E9aWNlLXB3ZDonICsgdHJhbnNwb3J0LnB3ZCk7XG4gICAgICAgIH1cbiAgICAgICAgZmluZ2VycHJpbnRzLmZvckVhY2goZnVuY3Rpb24gKGZpbmdlcnByaW50KSB7XG4gICAgICAgICAgICBzZHAucHVzaCgnYT1maW5nZXJwcmludDonICsgZmluZ2VycHJpbnQuaGFzaCArICcgJyArIGZpbmdlcnByaW50LnZhbHVlKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgc2RwLnB1c2goJ2E9JyArIChzZW5kZXJzW2NvbnRlbnQuc2VuZGVyc10gfHwgJ3NlbmRyZWN2JykpO1xuICAgIHNkcC5wdXNoKCdhPW1pZDonICsgY29udGVudC5uYW1lKTtcblxuICAgIGlmIChkZXNjLm11eCkge1xuICAgICAgICBzZHAucHVzaCgnYT1ydGNwLW11eCcpO1xuICAgIH1cblxuICAgIHZhciBlbmNyeXB0aW9uID0gZGVzYy5lbmNyeXB0aW9uIHx8IFtdO1xuICAgIGVuY3J5cHRpb24uZm9yRWFjaChmdW5jdGlvbiAoY3J5cHRvKSB7XG4gICAgICAgIHNkcC5wdXNoKCdhPWNyeXB0bzonICsgY3J5cHRvLnRhZyArICcgJyArIGNyeXB0by5jaXBoZXJTdWl0ZSArICcgJyArIGNyeXB0by5rZXlQYXJhbXMgKyAoY3J5cHRvLnNlc3Npb25QYXJhbXMgPyAnICcgKyBjcnlwdG8uc2Vzc2lvblBhcmFtcyA6ICcnKSk7XG4gICAgfSk7XG5cbiAgICBwYXlsb2Fkcy5mb3JFYWNoKGZ1bmN0aW9uIChwYXlsb2FkKSB7XG4gICAgICAgIHZhciBydHBtYXAgPSAnYT1ydHBtYXA6JyArIHBheWxvYWQuaWQgKyAnICcgKyBwYXlsb2FkLm5hbWUgKyAnLycgKyBwYXlsb2FkLmNsb2NrcmF0ZTtcbiAgICAgICAgaWYgKHBheWxvYWQuY2hhbm5lbHMgJiYgcGF5bG9hZC5jaGFubmVscyAhPSAnMScpIHtcbiAgICAgICAgICAgIHJ0cG1hcCArPSAnLycgKyBwYXlsb2FkLmNoYW5uZWxzO1xuICAgICAgICB9XG4gICAgICAgIHNkcC5wdXNoKHJ0cG1hcCk7XG5cbiAgICAgICAgaWYgKHBheWxvYWQucGFyYW1ldGVycyAmJiBwYXlsb2FkLnBhcmFtZXRlcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICB2YXIgZm10cCA9IFsnYT1mbXRwOicgKyBwYXlsb2FkLmlkXTtcbiAgICAgICAgICAgIHBheWxvYWQucGFyYW1ldGVycy5mb3JFYWNoKGZ1bmN0aW9uIChwYXJhbSkge1xuICAgICAgICAgICAgICAgIGZtdHAucHVzaCgocGFyYW0ua2V5ID8gcGFyYW0ua2V5ICsgJz0nIDogJycpICsgcGFyYW0udmFsdWUpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZHAucHVzaChmbXRwLmpvaW4oJyAnKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocGF5bG9hZC5mZWVkYmFjaykge1xuICAgICAgICAgICAgcGF5bG9hZC5mZWVkYmFjay5mb3JFYWNoKGZ1bmN0aW9uIChmYikge1xuICAgICAgICAgICAgICAgIGlmIChmYi50eXBlID09PSAndHJyLWludCcpIHtcbiAgICAgICAgICAgICAgICAgICAgc2RwLnB1c2goJ2E9cnRjcC1mYjonICsgcGF5bG9hZC5pZCArICcgdHJyLWludCAnICsgZmIudmFsdWUgPyBmYi52YWx1ZSA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc2RwLnB1c2goJ2E9cnRjcC1mYjonICsgcGF5bG9hZC5pZCArICcgJyArIGZiLnR5cGUgKyAoZmIuc3VidHlwZSA/ICcgJyArIGZiLnN1YnR5cGUgOiAnJykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoZGVzYy5mZWVkYmFjaykge1xuICAgICAgICBkZXNjLmZlZWRiYWNrLmZvckVhY2goZnVuY3Rpb24gKGZiKSB7XG4gICAgICAgICAgICBpZiAoZmIudHlwZSA9PT0gJ3Ryci1pbnQnKSB7XG4gICAgICAgICAgICAgICAgc2RwLnB1c2goJ2E9cnRjcC1mYjoqIHRyci1pbnQgJyArIGZiLnZhbHVlID8gZmIudmFsdWUgOiAnMCcpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzZHAucHVzaCgnYT1ydGNwLWZiOiogJyArIGZiLnR5cGUgKyAoZmIuc3VidHlwZSA/ICcgJyArIGZiLnN1YnR5cGUgOiAnJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB2YXIgaGRyRXh0cyA9IGRlc2MuaGVhZGVyRXh0ZW5zaW9ucyB8fCBbXTtcbiAgICBoZHJFeHRzLmZvckVhY2goZnVuY3Rpb24gKGhkcikge1xuICAgICAgICBzZHAucHVzaCgnYT1leHRtYXA6JyArIGhkci5pZCArIChoZHIuc2VuZGVycyA/ICcvJyArIHNlbmRlcnNbaGRyLnNlbmRlcnNdIDogJycpICsgJyAnICsgaGRyLnVyaSk7XG4gICAgfSk7XG5cbiAgICB2YXIgc3NyY3MgPSBkZXNjLnNzcmNzIHx8IFtdO1xuICAgIHNzcmNzLmZvckVhY2goZnVuY3Rpb24gKHNzcmMpIHtcbiAgICAgICAgZm9yICh2YXIgYXR0cmlidXRlIGluIHNzcmMpIHtcbiAgICAgICAgICAgIGlmIChhdHRyaWJ1dGUgPT0gJ3NzcmMnKSBjb250aW51ZTtcbiAgICAgICAgICAgIHNkcC5wdXNoKCdhPXNzcmM6JyArIChzc3JjLnNzcmMgfHwgZGVzYy5zc3JjKSArICcgJyArIGF0dHJpYnV0ZSArIChzc3JjW2F0dHJpYnV0ZV0gPyAoJzonICsgc3NyY1thdHRyaWJ1dGVdKSA6ICcnKSk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHZhciBjYW5kaWRhdGVzID0gdHJhbnNwb3J0LmNhbmRpZGF0ZXMgfHwgW107XG4gICAgY2FuZGlkYXRlcy5mb3JFYWNoKGZ1bmN0aW9uIChjYW5kaWRhdGUpIHtcbiAgICAgICAgc2RwLnB1c2goZXhwb3J0cy50b0NhbmRpZGF0ZVNEUChjYW5kaWRhdGUpKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBzZHAuam9pbignXFxyXFxuJyk7XG59O1xuXG5leHBvcnRzLnRvQ2FuZGlkYXRlU0RQID0gZnVuY3Rpb24gKGNhbmRpZGF0ZSkge1xuICAgIHZhciBzZHAgPSBbXTtcblxuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5mb3VuZGF0aW9uKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUuY29tcG9uZW50KTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUucHJvdG9jb2wpO1xuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5wcmlvcml0eSk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLmlwKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUucG9ydCk7XG5cbiAgICB2YXIgdHlwZSA9IGNhbmRpZGF0ZS50eXBlO1xuICAgIHNkcC5wdXNoKCd0eXAnKTtcbiAgICBzZHAucHVzaCh0eXBlKTtcbiAgICBpZiAodHlwZSA9PT0gJ3NyZmx4JyB8fCB0eXBlID09PSAncHJmbHgnIHx8IHR5cGUgPT09ICdyZWxheScpIHtcbiAgICAgICAgaWYgKGNhbmRpZGF0ZS5yZWxBZGRyICYmIGNhbmRpZGF0ZS5yZWxQb3J0KSB7XG4gICAgICAgICAgICBzZHAucHVzaCgncmFkZHInKTtcbiAgICAgICAgICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5yZWxBZGRyKTtcbiAgICAgICAgICAgIHNkcC5wdXNoKCdycG9ydCcpO1xuICAgICAgICAgICAgc2RwLnB1c2goY2FuZGlkYXRlLnJlbFBvcnQpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2RwLnB1c2goJ2dlbmVyYXRpb24nKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUuZ2VuZXJhdGlvbiB8fCAnMCcpO1xuXG4gICAgcmV0dXJuICdhPWNhbmRpZGF0ZTonICsgc2RwLmpvaW4oJyAnKTtcbn07XG4iLCIvLyAgICAgVW5kZXJzY29yZS5qcyAxLjUuMlxuLy8gICAgIGh0dHA6Ly91bmRlcnNjb3JlanMub3JnXG4vLyAgICAgKGMpIDIwMDktMjAxMyBKZXJlbXkgQXNoa2VuYXMsIERvY3VtZW50Q2xvdWQgYW5kIEludmVzdGlnYXRpdmUgUmVwb3J0ZXJzICYgRWRpdG9yc1xuLy8gICAgIFVuZGVyc2NvcmUgbWF5IGJlIGZyZWVseSBkaXN0cmlidXRlZCB1bmRlciB0aGUgTUlUIGxpY2Vuc2UuXG5cbihmdW5jdGlvbigpIHtcblxuICAvLyBCYXNlbGluZSBzZXR1cFxuICAvLyAtLS0tLS0tLS0tLS0tLVxuXG4gIC8vIEVzdGFibGlzaCB0aGUgcm9vdCBvYmplY3QsIGB3aW5kb3dgIGluIHRoZSBicm93c2VyLCBvciBgZXhwb3J0c2Agb24gdGhlIHNlcnZlci5cbiAgdmFyIHJvb3QgPSB0aGlzO1xuXG4gIC8vIFNhdmUgdGhlIHByZXZpb3VzIHZhbHVlIG9mIHRoZSBgX2AgdmFyaWFibGUuXG4gIHZhciBwcmV2aW91c1VuZGVyc2NvcmUgPSByb290Ll87XG5cbiAgLy8gRXN0YWJsaXNoIHRoZSBvYmplY3QgdGhhdCBnZXRzIHJldHVybmVkIHRvIGJyZWFrIG91dCBvZiBhIGxvb3AgaXRlcmF0aW9uLlxuICB2YXIgYnJlYWtlciA9IHt9O1xuXG4gIC8vIFNhdmUgYnl0ZXMgaW4gdGhlIG1pbmlmaWVkIChidXQgbm90IGd6aXBwZWQpIHZlcnNpb246XG4gIHZhciBBcnJheVByb3RvID0gQXJyYXkucHJvdG90eXBlLCBPYmpQcm90byA9IE9iamVjdC5wcm90b3R5cGUsIEZ1bmNQcm90byA9IEZ1bmN0aW9uLnByb3RvdHlwZTtcblxuICAvLyBDcmVhdGUgcXVpY2sgcmVmZXJlbmNlIHZhcmlhYmxlcyBmb3Igc3BlZWQgYWNjZXNzIHRvIGNvcmUgcHJvdG90eXBlcy5cbiAgdmFyXG4gICAgcHVzaCAgICAgICAgICAgICA9IEFycmF5UHJvdG8ucHVzaCxcbiAgICBzbGljZSAgICAgICAgICAgID0gQXJyYXlQcm90by5zbGljZSxcbiAgICBjb25jYXQgICAgICAgICAgID0gQXJyYXlQcm90by5jb25jYXQsXG4gICAgdG9TdHJpbmcgICAgICAgICA9IE9ialByb3RvLnRvU3RyaW5nLFxuICAgIGhhc093blByb3BlcnR5ICAgPSBPYmpQcm90by5oYXNPd25Qcm9wZXJ0eTtcblxuICAvLyBBbGwgKipFQ01BU2NyaXB0IDUqKiBuYXRpdmUgZnVuY3Rpb24gaW1wbGVtZW50YXRpb25zIHRoYXQgd2UgaG9wZSB0byB1c2VcbiAgLy8gYXJlIGRlY2xhcmVkIGhlcmUuXG4gIHZhclxuICAgIG5hdGl2ZUZvckVhY2ggICAgICA9IEFycmF5UHJvdG8uZm9yRWFjaCxcbiAgICBuYXRpdmVNYXAgICAgICAgICAgPSBBcnJheVByb3RvLm1hcCxcbiAgICBuYXRpdmVSZWR1Y2UgICAgICAgPSBBcnJheVByb3RvLnJlZHVjZSxcbiAgICBuYXRpdmVSZWR1Y2VSaWdodCAgPSBBcnJheVByb3RvLnJlZHVjZVJpZ2h0LFxuICAgIG5hdGl2ZUZpbHRlciAgICAgICA9IEFycmF5UHJvdG8uZmlsdGVyLFxuICAgIG5hdGl2ZUV2ZXJ5ICAgICAgICA9IEFycmF5UHJvdG8uZXZlcnksXG4gICAgbmF0aXZlU29tZSAgICAgICAgID0gQXJyYXlQcm90by5zb21lLFxuICAgIG5hdGl2ZUluZGV4T2YgICAgICA9IEFycmF5UHJvdG8uaW5kZXhPZixcbiAgICBuYXRpdmVMYXN0SW5kZXhPZiAgPSBBcnJheVByb3RvLmxhc3RJbmRleE9mLFxuICAgIG5hdGl2ZUlzQXJyYXkgICAgICA9IEFycmF5LmlzQXJyYXksXG4gICAgbmF0aXZlS2V5cyAgICAgICAgID0gT2JqZWN0LmtleXMsXG4gICAgbmF0aXZlQmluZCAgICAgICAgID0gRnVuY1Byb3RvLmJpbmQ7XG5cbiAgLy8gQ3JlYXRlIGEgc2FmZSByZWZlcmVuY2UgdG8gdGhlIFVuZGVyc2NvcmUgb2JqZWN0IGZvciB1c2UgYmVsb3cuXG4gIHZhciBfID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgaWYgKG9iaiBpbnN0YW5jZW9mIF8pIHJldHVybiBvYmo7XG4gICAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIF8pKSByZXR1cm4gbmV3IF8ob2JqKTtcbiAgICB0aGlzLl93cmFwcGVkID0gb2JqO1xuICB9O1xuXG4gIC8vIEV4cG9ydCB0aGUgVW5kZXJzY29yZSBvYmplY3QgZm9yICoqTm9kZS5qcyoqLCB3aXRoXG4gIC8vIGJhY2t3YXJkcy1jb21wYXRpYmlsaXR5IGZvciB0aGUgb2xkIGByZXF1aXJlKClgIEFQSS4gSWYgd2UncmUgaW5cbiAgLy8gdGhlIGJyb3dzZXIsIGFkZCBgX2AgYXMgYSBnbG9iYWwgb2JqZWN0IHZpYSBhIHN0cmluZyBpZGVudGlmaWVyLFxuICAvLyBmb3IgQ2xvc3VyZSBDb21waWxlciBcImFkdmFuY2VkXCIgbW9kZS5cbiAgaWYgKHR5cGVvZiBleHBvcnRzICE9PSAndW5kZWZpbmVkJykge1xuICAgIGlmICh0eXBlb2YgbW9kdWxlICE9PSAndW5kZWZpbmVkJyAmJiBtb2R1bGUuZXhwb3J0cykge1xuICAgICAgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzID0gXztcbiAgICB9XG4gICAgZXhwb3J0cy5fID0gXztcbiAgfSBlbHNlIHtcbiAgICByb290Ll8gPSBfO1xuICB9XG5cbiAgLy8gQ3VycmVudCB2ZXJzaW9uLlxuICBfLlZFUlNJT04gPSAnMS41LjInO1xuXG4gIC8vIENvbGxlY3Rpb24gRnVuY3Rpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgLy8gVGhlIGNvcm5lcnN0b25lLCBhbiBgZWFjaGAgaW1wbGVtZW50YXRpb24sIGFrYSBgZm9yRWFjaGAuXG4gIC8vIEhhbmRsZXMgb2JqZWN0cyB3aXRoIHRoZSBidWlsdC1pbiBgZm9yRWFjaGAsIGFycmF5cywgYW5kIHJhdyBvYmplY3RzLlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgZm9yRWFjaGAgaWYgYXZhaWxhYmxlLlxuICB2YXIgZWFjaCA9IF8uZWFjaCA9IF8uZm9yRWFjaCA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpZiAob2JqID09IG51bGwpIHJldHVybjtcbiAgICBpZiAobmF0aXZlRm9yRWFjaCAmJiBvYmouZm9yRWFjaCA9PT0gbmF0aXZlRm9yRWFjaCkge1xuICAgICAgb2JqLmZvckVhY2goaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgIH0gZWxzZSBpZiAob2JqLmxlbmd0aCA9PT0gK29iai5sZW5ndGgpIHtcbiAgICAgIGZvciAodmFyIGkgPSAwLCBsZW5ndGggPSBvYmoubGVuZ3RoOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgb2JqW2ldLCBpLCBvYmopID09PSBicmVha2VyKSByZXR1cm47XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciBrZXlzID0gXy5rZXlzKG9iaik7XG4gICAgICBmb3IgKHZhciBpID0gMCwgbGVuZ3RoID0ga2V5cy5sZW5ndGg7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoaXRlcmF0b3IuY2FsbChjb250ZXh0LCBvYmpba2V5c1tpXV0sIGtleXNbaV0sIG9iaikgPT09IGJyZWFrZXIpIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgLy8gUmV0dXJuIHRoZSByZXN1bHRzIG9mIGFwcGx5aW5nIHRoZSBpdGVyYXRvciB0byBlYWNoIGVsZW1lbnQuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBtYXBgIGlmIGF2YWlsYWJsZS5cbiAgXy5tYXAgPSBfLmNvbGxlY3QgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgdmFyIHJlc3VsdHMgPSBbXTtcbiAgICBpZiAob2JqID09IG51bGwpIHJldHVybiByZXN1bHRzO1xuICAgIGlmIChuYXRpdmVNYXAgJiYgb2JqLm1hcCA9PT0gbmF0aXZlTWFwKSByZXR1cm4gb2JqLm1hcChpdGVyYXRvciwgY29udGV4dCk7XG4gICAgZWFjaChvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCwgbGlzdCkge1xuICAgICAgcmVzdWx0cy5wdXNoKGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgdmFsdWUsIGluZGV4LCBsaXN0KSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH07XG5cbiAgdmFyIHJlZHVjZUVycm9yID0gJ1JlZHVjZSBvZiBlbXB0eSBhcnJheSB3aXRoIG5vIGluaXRpYWwgdmFsdWUnO1xuXG4gIC8vICoqUmVkdWNlKiogYnVpbGRzIHVwIGEgc2luZ2xlIHJlc3VsdCBmcm9tIGEgbGlzdCBvZiB2YWx1ZXMsIGFrYSBgaW5qZWN0YCxcbiAgLy8gb3IgYGZvbGRsYC4gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYHJlZHVjZWAgaWYgYXZhaWxhYmxlLlxuICBfLnJlZHVjZSA9IF8uZm9sZGwgPSBfLmluamVjdCA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIG1lbW8sIGNvbnRleHQpIHtcbiAgICB2YXIgaW5pdGlhbCA9IGFyZ3VtZW50cy5sZW5ndGggPiAyO1xuICAgIGlmIChvYmogPT0gbnVsbCkgb2JqID0gW107XG4gICAgaWYgKG5hdGl2ZVJlZHVjZSAmJiBvYmoucmVkdWNlID09PSBuYXRpdmVSZWR1Y2UpIHtcbiAgICAgIGlmIChjb250ZXh0KSBpdGVyYXRvciA9IF8uYmluZChpdGVyYXRvciwgY29udGV4dCk7XG4gICAgICByZXR1cm4gaW5pdGlhbCA/IG9iai5yZWR1Y2UoaXRlcmF0b3IsIG1lbW8pIDogb2JqLnJlZHVjZShpdGVyYXRvcik7XG4gICAgfVxuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIGlmICghaW5pdGlhbCkge1xuICAgICAgICBtZW1vID0gdmFsdWU7XG4gICAgICAgIGluaXRpYWwgPSB0cnVlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWVtbyA9IGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgbWVtbywgdmFsdWUsIGluZGV4LCBsaXN0KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoIWluaXRpYWwpIHRocm93IG5ldyBUeXBlRXJyb3IocmVkdWNlRXJyb3IpO1xuICAgIHJldHVybiBtZW1vO1xuICB9O1xuXG4gIC8vIFRoZSByaWdodC1hc3NvY2lhdGl2ZSB2ZXJzaW9uIG9mIHJlZHVjZSwgYWxzbyBrbm93biBhcyBgZm9sZHJgLlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgcmVkdWNlUmlnaHRgIGlmIGF2YWlsYWJsZS5cbiAgXy5yZWR1Y2VSaWdodCA9IF8uZm9sZHIgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBtZW1vLCBjb250ZXh0KSB7XG4gICAgdmFyIGluaXRpYWwgPSBhcmd1bWVudHMubGVuZ3RoID4gMjtcbiAgICBpZiAob2JqID09IG51bGwpIG9iaiA9IFtdO1xuICAgIGlmIChuYXRpdmVSZWR1Y2VSaWdodCAmJiBvYmoucmVkdWNlUmlnaHQgPT09IG5hdGl2ZVJlZHVjZVJpZ2h0KSB7XG4gICAgICBpZiAoY29udGV4dCkgaXRlcmF0b3IgPSBfLmJpbmQoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgICAgcmV0dXJuIGluaXRpYWwgPyBvYmoucmVkdWNlUmlnaHQoaXRlcmF0b3IsIG1lbW8pIDogb2JqLnJlZHVjZVJpZ2h0KGl0ZXJhdG9yKTtcbiAgICB9XG4gICAgdmFyIGxlbmd0aCA9IG9iai5sZW5ndGg7XG4gICAgaWYgKGxlbmd0aCAhPT0gK2xlbmd0aCkge1xuICAgICAgdmFyIGtleXMgPSBfLmtleXMob2JqKTtcbiAgICAgIGxlbmd0aCA9IGtleXMubGVuZ3RoO1xuICAgIH1cbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICBpbmRleCA9IGtleXMgPyBrZXlzWy0tbGVuZ3RoXSA6IC0tbGVuZ3RoO1xuICAgICAgaWYgKCFpbml0aWFsKSB7XG4gICAgICAgIG1lbW8gPSBvYmpbaW5kZXhdO1xuICAgICAgICBpbml0aWFsID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1lbW8gPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIG1lbW8sIG9ialtpbmRleF0sIGluZGV4LCBsaXN0KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoIWluaXRpYWwpIHRocm93IG5ldyBUeXBlRXJyb3IocmVkdWNlRXJyb3IpO1xuICAgIHJldHVybiBtZW1vO1xuICB9O1xuXG4gIC8vIFJldHVybiB0aGUgZmlyc3QgdmFsdWUgd2hpY2ggcGFzc2VzIGEgdHJ1dGggdGVzdC4gQWxpYXNlZCBhcyBgZGV0ZWN0YC5cbiAgXy5maW5kID0gXy5kZXRlY3QgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgdmFyIHJlc3VsdDtcbiAgICBhbnkob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIGlmIChpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkpIHtcbiAgICAgICAgcmVzdWx0ID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG5cbiAgLy8gUmV0dXJuIGFsbCB0aGUgZWxlbWVudHMgdGhhdCBwYXNzIGEgdHJ1dGggdGVzdC5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYGZpbHRlcmAgaWYgYXZhaWxhYmxlLlxuICAvLyBBbGlhc2VkIGFzIGBzZWxlY3RgLlxuICBfLmZpbHRlciA9IF8uc2VsZWN0ID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIHZhciByZXN1bHRzID0gW107XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gcmVzdWx0cztcbiAgICBpZiAobmF0aXZlRmlsdGVyICYmIG9iai5maWx0ZXIgPT09IG5hdGl2ZUZpbHRlcikgcmV0dXJuIG9iai5maWx0ZXIoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIGlmIChpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkpIHJlc3VsdHMucHVzaCh2YWx1ZSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH07XG5cbiAgLy8gUmV0dXJuIGFsbCB0aGUgZWxlbWVudHMgZm9yIHdoaWNoIGEgdHJ1dGggdGVzdCBmYWlscy5cbiAgXy5yZWplY3QgPSBmdW5jdGlvbihvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgcmV0dXJuIF8uZmlsdGVyKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICByZXR1cm4gIWl0ZXJhdG9yLmNhbGwoY29udGV4dCwgdmFsdWUsIGluZGV4LCBsaXN0KTtcbiAgICB9LCBjb250ZXh0KTtcbiAgfTtcblxuICAvLyBEZXRlcm1pbmUgd2hldGhlciBhbGwgb2YgdGhlIGVsZW1lbnRzIG1hdGNoIGEgdHJ1dGggdGVzdC5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYGV2ZXJ5YCBpZiBhdmFpbGFibGUuXG4gIC8vIEFsaWFzZWQgYXMgYGFsbGAuXG4gIF8uZXZlcnkgPSBfLmFsbCA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpdGVyYXRvciB8fCAoaXRlcmF0b3IgPSBfLmlkZW50aXR5KTtcbiAgICB2YXIgcmVzdWx0ID0gdHJ1ZTtcbiAgICBpZiAob2JqID09IG51bGwpIHJldHVybiByZXN1bHQ7XG4gICAgaWYgKG5hdGl2ZUV2ZXJ5ICYmIG9iai5ldmVyeSA9PT0gbmF0aXZlRXZlcnkpIHJldHVybiBvYmouZXZlcnkoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIGlmICghKHJlc3VsdCA9IHJlc3VsdCAmJiBpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkpKSByZXR1cm4gYnJlYWtlcjtcbiAgICB9KTtcbiAgICByZXR1cm4gISFyZXN1bHQ7XG4gIH07XG5cbiAgLy8gRGV0ZXJtaW5lIGlmIGF0IGxlYXN0IG9uZSBlbGVtZW50IGluIHRoZSBvYmplY3QgbWF0Y2hlcyBhIHRydXRoIHRlc3QuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBzb21lYCBpZiBhdmFpbGFibGUuXG4gIC8vIEFsaWFzZWQgYXMgYGFueWAuXG4gIHZhciBhbnkgPSBfLnNvbWUgPSBfLmFueSA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpdGVyYXRvciB8fCAoaXRlcmF0b3IgPSBfLmlkZW50aXR5KTtcbiAgICB2YXIgcmVzdWx0ID0gZmFsc2U7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gcmVzdWx0O1xuICAgIGlmIChuYXRpdmVTb21lICYmIG9iai5zb21lID09PSBuYXRpdmVTb21lKSByZXR1cm4gb2JqLnNvbWUoaXRlcmF0b3IsIGNvbnRleHQpO1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIGlmIChyZXN1bHQgfHwgKHJlc3VsdCA9IGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgdmFsdWUsIGluZGV4LCBsaXN0KSkpIHJldHVybiBicmVha2VyO1xuICAgIH0pO1xuICAgIHJldHVybiAhIXJlc3VsdDtcbiAgfTtcblxuICAvLyBEZXRlcm1pbmUgaWYgdGhlIGFycmF5IG9yIG9iamVjdCBjb250YWlucyBhIGdpdmVuIHZhbHVlICh1c2luZyBgPT09YCkuXG4gIC8vIEFsaWFzZWQgYXMgYGluY2x1ZGVgLlxuICBfLmNvbnRhaW5zID0gXy5pbmNsdWRlID0gZnVuY3Rpb24ob2JqLCB0YXJnZXQpIHtcbiAgICBpZiAob2JqID09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobmF0aXZlSW5kZXhPZiAmJiBvYmouaW5kZXhPZiA9PT0gbmF0aXZlSW5kZXhPZikgcmV0dXJuIG9iai5pbmRleE9mKHRhcmdldCkgIT0gLTE7XG4gICAgcmV0dXJuIGFueShvYmosIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICByZXR1cm4gdmFsdWUgPT09IHRhcmdldDtcbiAgICB9KTtcbiAgfTtcblxuICAvLyBJbnZva2UgYSBtZXRob2QgKHdpdGggYXJndW1lbnRzKSBvbiBldmVyeSBpdGVtIGluIGEgY29sbGVjdGlvbi5cbiAgXy5pbnZva2UgPSBmdW5jdGlvbihvYmosIG1ldGhvZCkge1xuICAgIHZhciBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgIHZhciBpc0Z1bmMgPSBfLmlzRnVuY3Rpb24obWV0aG9kKTtcbiAgICByZXR1cm4gXy5tYXAob2JqLCBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgcmV0dXJuIChpc0Z1bmMgPyBtZXRob2QgOiB2YWx1ZVttZXRob2RdKS5hcHBseSh2YWx1ZSwgYXJncyk7XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gQ29udmVuaWVuY2UgdmVyc2lvbiBvZiBhIGNvbW1vbiB1c2UgY2FzZSBvZiBgbWFwYDogZmV0Y2hpbmcgYSBwcm9wZXJ0eS5cbiAgXy5wbHVjayA9IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgcmV0dXJuIF8ubWFwKG9iaiwgZnVuY3Rpb24odmFsdWUpeyByZXR1cm4gdmFsdWVba2V5XTsgfSk7XG4gIH07XG5cbiAgLy8gQ29udmVuaWVuY2UgdmVyc2lvbiBvZiBhIGNvbW1vbiB1c2UgY2FzZSBvZiBgZmlsdGVyYDogc2VsZWN0aW5nIG9ubHkgb2JqZWN0c1xuICAvLyBjb250YWluaW5nIHNwZWNpZmljIGBrZXk6dmFsdWVgIHBhaXJzLlxuICBfLndoZXJlID0gZnVuY3Rpb24ob2JqLCBhdHRycywgZmlyc3QpIHtcbiAgICBpZiAoXy5pc0VtcHR5KGF0dHJzKSkgcmV0dXJuIGZpcnN0ID8gdm9pZCAwIDogW107XG4gICAgcmV0dXJuIF9bZmlyc3QgPyAnZmluZCcgOiAnZmlsdGVyJ10ob2JqLCBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgZm9yICh2YXIga2V5IGluIGF0dHJzKSB7XG4gICAgICAgIGlmIChhdHRyc1trZXldICE9PSB2YWx1ZVtrZXldKSByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcbiAgfTtcblxuICAvLyBDb252ZW5pZW5jZSB2ZXJzaW9uIG9mIGEgY29tbW9uIHVzZSBjYXNlIG9mIGBmaW5kYDogZ2V0dGluZyB0aGUgZmlyc3Qgb2JqZWN0XG4gIC8vIGNvbnRhaW5pbmcgc3BlY2lmaWMgYGtleTp2YWx1ZWAgcGFpcnMuXG4gIF8uZmluZFdoZXJlID0gZnVuY3Rpb24ob2JqLCBhdHRycykge1xuICAgIHJldHVybiBfLndoZXJlKG9iaiwgYXR0cnMsIHRydWUpO1xuICB9O1xuXG4gIC8vIFJldHVybiB0aGUgbWF4aW11bSBlbGVtZW50IG9yIChlbGVtZW50LWJhc2VkIGNvbXB1dGF0aW9uKS5cbiAgLy8gQ2FuJ3Qgb3B0aW1pemUgYXJyYXlzIG9mIGludGVnZXJzIGxvbmdlciB0aGFuIDY1LDUzNSBlbGVtZW50cy5cbiAgLy8gU2VlIFtXZWJLaXQgQnVnIDgwNzk3XShodHRwczovL2J1Z3Mud2Via2l0Lm9yZy9zaG93X2J1Zy5jZ2k/aWQ9ODA3OTcpXG4gIF8ubWF4ID0gZnVuY3Rpb24ob2JqLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIGlmICghaXRlcmF0b3IgJiYgXy5pc0FycmF5KG9iaikgJiYgb2JqWzBdID09PSArb2JqWzBdICYmIG9iai5sZW5ndGggPCA2NTUzNSkge1xuICAgICAgcmV0dXJuIE1hdGgubWF4LmFwcGx5KE1hdGgsIG9iaik7XG4gICAgfVxuICAgIGlmICghaXRlcmF0b3IgJiYgXy5pc0VtcHR5KG9iaikpIHJldHVybiAtSW5maW5pdHk7XG4gICAgdmFyIHJlc3VsdCA9IHtjb21wdXRlZCA6IC1JbmZpbml0eSwgdmFsdWU6IC1JbmZpbml0eX07XG4gICAgZWFjaChvYmosIGZ1bmN0aW9uKHZhbHVlLCBpbmRleCwgbGlzdCkge1xuICAgICAgdmFyIGNvbXB1dGVkID0gaXRlcmF0b3IgPyBpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgbGlzdCkgOiB2YWx1ZTtcbiAgICAgIGNvbXB1dGVkID4gcmVzdWx0LmNvbXB1dGVkICYmIChyZXN1bHQgPSB7dmFsdWUgOiB2YWx1ZSwgY29tcHV0ZWQgOiBjb21wdXRlZH0pO1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHQudmFsdWU7XG4gIH07XG5cbiAgLy8gUmV0dXJuIHRoZSBtaW5pbXVtIGVsZW1lbnQgKG9yIGVsZW1lbnQtYmFzZWQgY29tcHV0YXRpb24pLlxuICBfLm1pbiA9IGZ1bmN0aW9uKG9iaiwgaXRlcmF0b3IsIGNvbnRleHQpIHtcbiAgICBpZiAoIWl0ZXJhdG9yICYmIF8uaXNBcnJheShvYmopICYmIG9ialswXSA9PT0gK29ialswXSAmJiBvYmoubGVuZ3RoIDwgNjU1MzUpIHtcbiAgICAgIHJldHVybiBNYXRoLm1pbi5hcHBseShNYXRoLCBvYmopO1xuICAgIH1cbiAgICBpZiAoIWl0ZXJhdG9yICYmIF8uaXNFbXB0eShvYmopKSByZXR1cm4gSW5maW5pdHk7XG4gICAgdmFyIHJlc3VsdCA9IHtjb21wdXRlZCA6IEluZmluaXR5LCB2YWx1ZTogSW5maW5pdHl9O1xuICAgIGVhY2gob2JqLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgsIGxpc3QpIHtcbiAgICAgIHZhciBjb21wdXRlZCA9IGl0ZXJhdG9yID8gaXRlcmF0b3IuY2FsbChjb250ZXh0LCB2YWx1ZSwgaW5kZXgsIGxpc3QpIDogdmFsdWU7XG4gICAgICBjb21wdXRlZCA8IHJlc3VsdC5jb21wdXRlZCAmJiAocmVzdWx0ID0ge3ZhbHVlIDogdmFsdWUsIGNvbXB1dGVkIDogY29tcHV0ZWR9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0LnZhbHVlO1xuICB9O1xuXG4gIC8vIFNodWZmbGUgYW4gYXJyYXksIHVzaW5nIHRoZSBtb2Rlcm4gdmVyc2lvbiBvZiB0aGUgXG4gIC8vIFtGaXNoZXItWWF0ZXMgc2h1ZmZsZV0oaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9GaXNoZXLigJNZYXRlc19zaHVmZmxlKS5cbiAgXy5zaHVmZmxlID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIHJhbmQ7XG4gICAgdmFyIGluZGV4ID0gMDtcbiAgICB2YXIgc2h1ZmZsZWQgPSBbXTtcbiAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgIHJhbmQgPSBfLnJhbmRvbShpbmRleCsrKTtcbiAgICAgIHNodWZmbGVkW2luZGV4IC0gMV0gPSBzaHVmZmxlZFtyYW5kXTtcbiAgICAgIHNodWZmbGVkW3JhbmRdID0gdmFsdWU7XG4gICAgfSk7XG4gICAgcmV0dXJuIHNodWZmbGVkO1xuICB9O1xuXG4gIC8vIFNhbXBsZSAqKm4qKiByYW5kb20gdmFsdWVzIGZyb20gYW4gYXJyYXkuXG4gIC8vIElmICoqbioqIGlzIG5vdCBzcGVjaWZpZWQsIHJldHVybnMgYSBzaW5nbGUgcmFuZG9tIGVsZW1lbnQgZnJvbSB0aGUgYXJyYXkuXG4gIC8vIFRoZSBpbnRlcm5hbCBgZ3VhcmRgIGFyZ3VtZW50IGFsbG93cyBpdCB0byB3b3JrIHdpdGggYG1hcGAuXG4gIF8uc2FtcGxlID0gZnVuY3Rpb24ob2JqLCBuLCBndWFyZCkge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoIDwgMiB8fCBndWFyZCkge1xuICAgICAgcmV0dXJuIG9ialtfLnJhbmRvbShvYmoubGVuZ3RoIC0gMSldO1xuICAgIH1cbiAgICByZXR1cm4gXy5zaHVmZmxlKG9iaikuc2xpY2UoMCwgTWF0aC5tYXgoMCwgbikpO1xuICB9O1xuXG4gIC8vIEFuIGludGVybmFsIGZ1bmN0aW9uIHRvIGdlbmVyYXRlIGxvb2t1cCBpdGVyYXRvcnMuXG4gIHZhciBsb29rdXBJdGVyYXRvciA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgcmV0dXJuIF8uaXNGdW5jdGlvbih2YWx1ZSkgPyB2YWx1ZSA6IGZ1bmN0aW9uKG9iail7IHJldHVybiBvYmpbdmFsdWVdOyB9O1xuICB9O1xuXG4gIC8vIFNvcnQgdGhlIG9iamVjdCdzIHZhbHVlcyBieSBhIGNyaXRlcmlvbiBwcm9kdWNlZCBieSBhbiBpdGVyYXRvci5cbiAgXy5zb3J0QnkgPSBmdW5jdGlvbihvYmosIHZhbHVlLCBjb250ZXh0KSB7XG4gICAgdmFyIGl0ZXJhdG9yID0gbG9va3VwSXRlcmF0b3IodmFsdWUpO1xuICAgIHJldHVybiBfLnBsdWNrKF8ubWFwKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4LCBsaXN0KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICB2YWx1ZTogdmFsdWUsXG4gICAgICAgIGluZGV4OiBpbmRleCxcbiAgICAgICAgY3JpdGVyaWE6IGl0ZXJhdG9yLmNhbGwoY29udGV4dCwgdmFsdWUsIGluZGV4LCBsaXN0KVxuICAgICAgfTtcbiAgICB9KS5zb3J0KGZ1bmN0aW9uKGxlZnQsIHJpZ2h0KSB7XG4gICAgICB2YXIgYSA9IGxlZnQuY3JpdGVyaWE7XG4gICAgICB2YXIgYiA9IHJpZ2h0LmNyaXRlcmlhO1xuICAgICAgaWYgKGEgIT09IGIpIHtcbiAgICAgICAgaWYgKGEgPiBiIHx8IGEgPT09IHZvaWQgMCkgcmV0dXJuIDE7XG4gICAgICAgIGlmIChhIDwgYiB8fCBiID09PSB2b2lkIDApIHJldHVybiAtMTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBsZWZ0LmluZGV4IC0gcmlnaHQuaW5kZXg7XG4gICAgfSksICd2YWx1ZScpO1xuICB9O1xuXG4gIC8vIEFuIGludGVybmFsIGZ1bmN0aW9uIHVzZWQgZm9yIGFnZ3JlZ2F0ZSBcImdyb3VwIGJ5XCIgb3BlcmF0aW9ucy5cbiAgdmFyIGdyb3VwID0gZnVuY3Rpb24oYmVoYXZpb3IpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24ob2JqLCB2YWx1ZSwgY29udGV4dCkge1xuICAgICAgdmFyIHJlc3VsdCA9IHt9O1xuICAgICAgdmFyIGl0ZXJhdG9yID0gdmFsdWUgPT0gbnVsbCA/IF8uaWRlbnRpdHkgOiBsb29rdXBJdGVyYXRvcih2YWx1ZSk7XG4gICAgICBlYWNoKG9iaiwgZnVuY3Rpb24odmFsdWUsIGluZGV4KSB7XG4gICAgICAgIHZhciBrZXkgPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIHZhbHVlLCBpbmRleCwgb2JqKTtcbiAgICAgICAgYmVoYXZpb3IocmVzdWx0LCBrZXksIHZhbHVlKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICB9O1xuXG4gIC8vIEdyb3VwcyB0aGUgb2JqZWN0J3MgdmFsdWVzIGJ5IGEgY3JpdGVyaW9uLiBQYXNzIGVpdGhlciBhIHN0cmluZyBhdHRyaWJ1dGVcbiAgLy8gdG8gZ3JvdXAgYnksIG9yIGEgZnVuY3Rpb24gdGhhdCByZXR1cm5zIHRoZSBjcml0ZXJpb24uXG4gIF8uZ3JvdXBCeSA9IGdyb3VwKGZ1bmN0aW9uKHJlc3VsdCwga2V5LCB2YWx1ZSkge1xuICAgIChfLmhhcyhyZXN1bHQsIGtleSkgPyByZXN1bHRba2V5XSA6IChyZXN1bHRba2V5XSA9IFtdKSkucHVzaCh2YWx1ZSk7XG4gIH0pO1xuXG4gIC8vIEluZGV4ZXMgdGhlIG9iamVjdCdzIHZhbHVlcyBieSBhIGNyaXRlcmlvbiwgc2ltaWxhciB0byBgZ3JvdXBCeWAsIGJ1dCBmb3JcbiAgLy8gd2hlbiB5b3Uga25vdyB0aGF0IHlvdXIgaW5kZXggdmFsdWVzIHdpbGwgYmUgdW5pcXVlLlxuICBfLmluZGV4QnkgPSBncm91cChmdW5jdGlvbihyZXN1bHQsIGtleSwgdmFsdWUpIHtcbiAgICByZXN1bHRba2V5XSA9IHZhbHVlO1xuICB9KTtcblxuICAvLyBDb3VudHMgaW5zdGFuY2VzIG9mIGFuIG9iamVjdCB0aGF0IGdyb3VwIGJ5IGEgY2VydGFpbiBjcml0ZXJpb24uIFBhc3NcbiAgLy8gZWl0aGVyIGEgc3RyaW5nIGF0dHJpYnV0ZSB0byBjb3VudCBieSwgb3IgYSBmdW5jdGlvbiB0aGF0IHJldHVybnMgdGhlXG4gIC8vIGNyaXRlcmlvbi5cbiAgXy5jb3VudEJ5ID0gZ3JvdXAoZnVuY3Rpb24ocmVzdWx0LCBrZXkpIHtcbiAgICBfLmhhcyhyZXN1bHQsIGtleSkgPyByZXN1bHRba2V5XSsrIDogcmVzdWx0W2tleV0gPSAxO1xuICB9KTtcblxuICAvLyBVc2UgYSBjb21wYXJhdG9yIGZ1bmN0aW9uIHRvIGZpZ3VyZSBvdXQgdGhlIHNtYWxsZXN0IGluZGV4IGF0IHdoaWNoXG4gIC8vIGFuIG9iamVjdCBzaG91bGQgYmUgaW5zZXJ0ZWQgc28gYXMgdG8gbWFpbnRhaW4gb3JkZXIuIFVzZXMgYmluYXJ5IHNlYXJjaC5cbiAgXy5zb3J0ZWRJbmRleCA9IGZ1bmN0aW9uKGFycmF5LCBvYmosIGl0ZXJhdG9yLCBjb250ZXh0KSB7XG4gICAgaXRlcmF0b3IgPSBpdGVyYXRvciA9PSBudWxsID8gXy5pZGVudGl0eSA6IGxvb2t1cEl0ZXJhdG9yKGl0ZXJhdG9yKTtcbiAgICB2YXIgdmFsdWUgPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIG9iaik7XG4gICAgdmFyIGxvdyA9IDAsIGhpZ2ggPSBhcnJheS5sZW5ndGg7XG4gICAgd2hpbGUgKGxvdyA8IGhpZ2gpIHtcbiAgICAgIHZhciBtaWQgPSAobG93ICsgaGlnaCkgPj4+IDE7XG4gICAgICBpdGVyYXRvci5jYWxsKGNvbnRleHQsIGFycmF5W21pZF0pIDwgdmFsdWUgPyBsb3cgPSBtaWQgKyAxIDogaGlnaCA9IG1pZDtcbiAgICB9XG4gICAgcmV0dXJuIGxvdztcbiAgfTtcblxuICAvLyBTYWZlbHkgY3JlYXRlIGEgcmVhbCwgbGl2ZSBhcnJheSBmcm9tIGFueXRoaW5nIGl0ZXJhYmxlLlxuICBfLnRvQXJyYXkgPSBmdW5jdGlvbihvYmopIHtcbiAgICBpZiAoIW9iaikgcmV0dXJuIFtdO1xuICAgIGlmIChfLmlzQXJyYXkob2JqKSkgcmV0dXJuIHNsaWNlLmNhbGwob2JqKTtcbiAgICBpZiAob2JqLmxlbmd0aCA9PT0gK29iai5sZW5ndGgpIHJldHVybiBfLm1hcChvYmosIF8uaWRlbnRpdHkpO1xuICAgIHJldHVybiBfLnZhbHVlcyhvYmopO1xuICB9O1xuXG4gIC8vIFJldHVybiB0aGUgbnVtYmVyIG9mIGVsZW1lbnRzIGluIGFuIG9iamVjdC5cbiAgXy5zaXplID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgaWYgKG9iaiA9PSBudWxsKSByZXR1cm4gMDtcbiAgICByZXR1cm4gKG9iai5sZW5ndGggPT09ICtvYmoubGVuZ3RoKSA/IG9iai5sZW5ndGggOiBfLmtleXMob2JqKS5sZW5ndGg7XG4gIH07XG5cbiAgLy8gQXJyYXkgRnVuY3Rpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLVxuXG4gIC8vIEdldCB0aGUgZmlyc3QgZWxlbWVudCBvZiBhbiBhcnJheS4gUGFzc2luZyAqKm4qKiB3aWxsIHJldHVybiB0aGUgZmlyc3QgTlxuICAvLyB2YWx1ZXMgaW4gdGhlIGFycmF5LiBBbGlhc2VkIGFzIGBoZWFkYCBhbmQgYHRha2VgLiBUaGUgKipndWFyZCoqIGNoZWNrXG4gIC8vIGFsbG93cyBpdCB0byB3b3JrIHdpdGggYF8ubWFwYC5cbiAgXy5maXJzdCA9IF8uaGVhZCA9IF8udGFrZSA9IGZ1bmN0aW9uKGFycmF5LCBuLCBndWFyZCkge1xuICAgIGlmIChhcnJheSA9PSBudWxsKSByZXR1cm4gdm9pZCAwO1xuICAgIHJldHVybiAobiA9PSBudWxsKSB8fCBndWFyZCA/IGFycmF5WzBdIDogc2xpY2UuY2FsbChhcnJheSwgMCwgbik7XG4gIH07XG5cbiAgLy8gUmV0dXJucyBldmVyeXRoaW5nIGJ1dCB0aGUgbGFzdCBlbnRyeSBvZiB0aGUgYXJyYXkuIEVzcGVjaWFsbHkgdXNlZnVsIG9uXG4gIC8vIHRoZSBhcmd1bWVudHMgb2JqZWN0LiBQYXNzaW5nICoqbioqIHdpbGwgcmV0dXJuIGFsbCB0aGUgdmFsdWVzIGluXG4gIC8vIHRoZSBhcnJheSwgZXhjbHVkaW5nIHRoZSBsYXN0IE4uIFRoZSAqKmd1YXJkKiogY2hlY2sgYWxsb3dzIGl0IHRvIHdvcmsgd2l0aFxuICAvLyBgXy5tYXBgLlxuICBfLmluaXRpYWwgPSBmdW5jdGlvbihhcnJheSwgbiwgZ3VhcmQpIHtcbiAgICByZXR1cm4gc2xpY2UuY2FsbChhcnJheSwgMCwgYXJyYXkubGVuZ3RoIC0gKChuID09IG51bGwpIHx8IGd1YXJkID8gMSA6IG4pKTtcbiAgfTtcblxuICAvLyBHZXQgdGhlIGxhc3QgZWxlbWVudCBvZiBhbiBhcnJheS4gUGFzc2luZyAqKm4qKiB3aWxsIHJldHVybiB0aGUgbGFzdCBOXG4gIC8vIHZhbHVlcyBpbiB0aGUgYXJyYXkuIFRoZSAqKmd1YXJkKiogY2hlY2sgYWxsb3dzIGl0IHRvIHdvcmsgd2l0aCBgXy5tYXBgLlxuICBfLmxhc3QgPSBmdW5jdGlvbihhcnJheSwgbiwgZ3VhcmQpIHtcbiAgICBpZiAoYXJyYXkgPT0gbnVsbCkgcmV0dXJuIHZvaWQgMDtcbiAgICBpZiAoKG4gPT0gbnVsbCkgfHwgZ3VhcmQpIHtcbiAgICAgIHJldHVybiBhcnJheVthcnJheS5sZW5ndGggLSAxXTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHNsaWNlLmNhbGwoYXJyYXksIE1hdGgubWF4KGFycmF5Lmxlbmd0aCAtIG4sIDApKTtcbiAgICB9XG4gIH07XG5cbiAgLy8gUmV0dXJucyBldmVyeXRoaW5nIGJ1dCB0aGUgZmlyc3QgZW50cnkgb2YgdGhlIGFycmF5LiBBbGlhc2VkIGFzIGB0YWlsYCBhbmQgYGRyb3BgLlxuICAvLyBFc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgYXJndW1lbnRzIG9iamVjdC4gUGFzc2luZyBhbiAqKm4qKiB3aWxsIHJldHVyblxuICAvLyB0aGUgcmVzdCBOIHZhbHVlcyBpbiB0aGUgYXJyYXkuIFRoZSAqKmd1YXJkKipcbiAgLy8gY2hlY2sgYWxsb3dzIGl0IHRvIHdvcmsgd2l0aCBgXy5tYXBgLlxuICBfLnJlc3QgPSBfLnRhaWwgPSBfLmRyb3AgPSBmdW5jdGlvbihhcnJheSwgbiwgZ3VhcmQpIHtcbiAgICByZXR1cm4gc2xpY2UuY2FsbChhcnJheSwgKG4gPT0gbnVsbCkgfHwgZ3VhcmQgPyAxIDogbik7XG4gIH07XG5cbiAgLy8gVHJpbSBvdXQgYWxsIGZhbHN5IHZhbHVlcyBmcm9tIGFuIGFycmF5LlxuICBfLmNvbXBhY3QgPSBmdW5jdGlvbihhcnJheSkge1xuICAgIHJldHVybiBfLmZpbHRlcihhcnJheSwgXy5pZGVudGl0eSk7XG4gIH07XG5cbiAgLy8gSW50ZXJuYWwgaW1wbGVtZW50YXRpb24gb2YgYSByZWN1cnNpdmUgYGZsYXR0ZW5gIGZ1bmN0aW9uLlxuICB2YXIgZmxhdHRlbiA9IGZ1bmN0aW9uKGlucHV0LCBzaGFsbG93LCBvdXRwdXQpIHtcbiAgICBpZiAoc2hhbGxvdyAmJiBfLmV2ZXJ5KGlucHV0LCBfLmlzQXJyYXkpKSB7XG4gICAgICByZXR1cm4gY29uY2F0LmFwcGx5KG91dHB1dCwgaW5wdXQpO1xuICAgIH1cbiAgICBlYWNoKGlucHV0LCBmdW5jdGlvbih2YWx1ZSkge1xuICAgICAgaWYgKF8uaXNBcnJheSh2YWx1ZSkgfHwgXy5pc0FyZ3VtZW50cyh2YWx1ZSkpIHtcbiAgICAgICAgc2hhbGxvdyA/IHB1c2guYXBwbHkob3V0cHV0LCB2YWx1ZSkgOiBmbGF0dGVuKHZhbHVlLCBzaGFsbG93LCBvdXRwdXQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0LnB1c2godmFsdWUpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJldHVybiBvdXRwdXQ7XG4gIH07XG5cbiAgLy8gRmxhdHRlbiBvdXQgYW4gYXJyYXksIGVpdGhlciByZWN1cnNpdmVseSAoYnkgZGVmYXVsdCksIG9yIGp1c3Qgb25lIGxldmVsLlxuICBfLmZsYXR0ZW4gPSBmdW5jdGlvbihhcnJheSwgc2hhbGxvdykge1xuICAgIHJldHVybiBmbGF0dGVuKGFycmF5LCBzaGFsbG93LCBbXSk7XG4gIH07XG5cbiAgLy8gUmV0dXJuIGEgdmVyc2lvbiBvZiB0aGUgYXJyYXkgdGhhdCBkb2VzIG5vdCBjb250YWluIHRoZSBzcGVjaWZpZWQgdmFsdWUocykuXG4gIF8ud2l0aG91dCA9IGZ1bmN0aW9uKGFycmF5KSB7XG4gICAgcmV0dXJuIF8uZGlmZmVyZW5jZShhcnJheSwgc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgfTtcblxuICAvLyBQcm9kdWNlIGEgZHVwbGljYXRlLWZyZWUgdmVyc2lvbiBvZiB0aGUgYXJyYXkuIElmIHRoZSBhcnJheSBoYXMgYWxyZWFkeVxuICAvLyBiZWVuIHNvcnRlZCwgeW91IGhhdmUgdGhlIG9wdGlvbiBvZiB1c2luZyBhIGZhc3RlciBhbGdvcml0aG0uXG4gIC8vIEFsaWFzZWQgYXMgYHVuaXF1ZWAuXG4gIF8udW5pcSA9IF8udW5pcXVlID0gZnVuY3Rpb24oYXJyYXksIGlzU29ydGVkLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIGlmIChfLmlzRnVuY3Rpb24oaXNTb3J0ZWQpKSB7XG4gICAgICBjb250ZXh0ID0gaXRlcmF0b3I7XG4gICAgICBpdGVyYXRvciA9IGlzU29ydGVkO1xuICAgICAgaXNTb3J0ZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgdmFyIGluaXRpYWwgPSBpdGVyYXRvciA/IF8ubWFwKGFycmF5LCBpdGVyYXRvciwgY29udGV4dCkgOiBhcnJheTtcbiAgICB2YXIgcmVzdWx0cyA9IFtdO1xuICAgIHZhciBzZWVuID0gW107XG4gICAgZWFjaChpbml0aWFsLCBmdW5jdGlvbih2YWx1ZSwgaW5kZXgpIHtcbiAgICAgIGlmIChpc1NvcnRlZCA/ICghaW5kZXggfHwgc2VlbltzZWVuLmxlbmd0aCAtIDFdICE9PSB2YWx1ZSkgOiAhXy5jb250YWlucyhzZWVuLCB2YWx1ZSkpIHtcbiAgICAgICAgc2Vlbi5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmVzdWx0cy5wdXNoKGFycmF5W2luZGV4XSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH07XG5cbiAgLy8gUHJvZHVjZSBhbiBhcnJheSB0aGF0IGNvbnRhaW5zIHRoZSB1bmlvbjogZWFjaCBkaXN0aW5jdCBlbGVtZW50IGZyb20gYWxsIG9mXG4gIC8vIHRoZSBwYXNzZWQtaW4gYXJyYXlzLlxuICBfLnVuaW9uID0gZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIF8udW5pcShfLmZsYXR0ZW4oYXJndW1lbnRzLCB0cnVlKSk7XG4gIH07XG5cbiAgLy8gUHJvZHVjZSBhbiBhcnJheSB0aGF0IGNvbnRhaW5zIGV2ZXJ5IGl0ZW0gc2hhcmVkIGJldHdlZW4gYWxsIHRoZVxuICAvLyBwYXNzZWQtaW4gYXJyYXlzLlxuICBfLmludGVyc2VjdGlvbiA9IGZ1bmN0aW9uKGFycmF5KSB7XG4gICAgdmFyIHJlc3QgPSBzbGljZS5jYWxsKGFyZ3VtZW50cywgMSk7XG4gICAgcmV0dXJuIF8uZmlsdGVyKF8udW5pcShhcnJheSksIGZ1bmN0aW9uKGl0ZW0pIHtcbiAgICAgIHJldHVybiBfLmV2ZXJ5KHJlc3QsIGZ1bmN0aW9uKG90aGVyKSB7XG4gICAgICAgIHJldHVybiBfLmluZGV4T2Yob3RoZXIsIGl0ZW0pID49IDA7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfTtcblxuICAvLyBUYWtlIHRoZSBkaWZmZXJlbmNlIGJldHdlZW4gb25lIGFycmF5IGFuZCBhIG51bWJlciBvZiBvdGhlciBhcnJheXMuXG4gIC8vIE9ubHkgdGhlIGVsZW1lbnRzIHByZXNlbnQgaW4ganVzdCB0aGUgZmlyc3QgYXJyYXkgd2lsbCByZW1haW4uXG4gIF8uZGlmZmVyZW5jZSA9IGZ1bmN0aW9uKGFycmF5KSB7XG4gICAgdmFyIHJlc3QgPSBjb25jYXQuYXBwbHkoQXJyYXlQcm90bywgc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgICByZXR1cm4gXy5maWx0ZXIoYXJyYXksIGZ1bmN0aW9uKHZhbHVlKXsgcmV0dXJuICFfLmNvbnRhaW5zKHJlc3QsIHZhbHVlKTsgfSk7XG4gIH07XG5cbiAgLy8gWmlwIHRvZ2V0aGVyIG11bHRpcGxlIGxpc3RzIGludG8gYSBzaW5nbGUgYXJyYXkgLS0gZWxlbWVudHMgdGhhdCBzaGFyZVxuICAvLyBhbiBpbmRleCBnbyB0b2dldGhlci5cbiAgXy56aXAgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgbGVuZ3RoID0gXy5tYXgoXy5wbHVjayhhcmd1bWVudHMsIFwibGVuZ3RoXCIpLmNvbmNhdCgwKSk7XG4gICAgdmFyIHJlc3VsdHMgPSBuZXcgQXJyYXkobGVuZ3RoKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICByZXN1bHRzW2ldID0gXy5wbHVjayhhcmd1bWVudHMsICcnICsgaSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHRzO1xuICB9O1xuXG4gIC8vIENvbnZlcnRzIGxpc3RzIGludG8gb2JqZWN0cy4gUGFzcyBlaXRoZXIgYSBzaW5nbGUgYXJyYXkgb2YgYFtrZXksIHZhbHVlXWBcbiAgLy8gcGFpcnMsIG9yIHR3byBwYXJhbGxlbCBhcnJheXMgb2YgdGhlIHNhbWUgbGVuZ3RoIC0tIG9uZSBvZiBrZXlzLCBhbmQgb25lIG9mXG4gIC8vIHRoZSBjb3JyZXNwb25kaW5nIHZhbHVlcy5cbiAgXy5vYmplY3QgPSBmdW5jdGlvbihsaXN0LCB2YWx1ZXMpIHtcbiAgICBpZiAobGlzdCA9PSBudWxsKSByZXR1cm4ge307XG4gICAgdmFyIHJlc3VsdCA9IHt9O1xuICAgIGZvciAodmFyIGkgPSAwLCBsZW5ndGggPSBsaXN0Lmxlbmd0aDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICBpZiAodmFsdWVzKSB7XG4gICAgICAgIHJlc3VsdFtsaXN0W2ldXSA9IHZhbHVlc1tpXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3VsdFtsaXN0W2ldWzBdXSA9IGxpc3RbaV1bMV07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG5cbiAgLy8gSWYgdGhlIGJyb3dzZXIgZG9lc24ndCBzdXBwbHkgdXMgd2l0aCBpbmRleE9mIChJJ20gbG9va2luZyBhdCB5b3UsICoqTVNJRSoqKSxcbiAgLy8gd2UgbmVlZCB0aGlzIGZ1bmN0aW9uLiBSZXR1cm4gdGhlIHBvc2l0aW9uIG9mIHRoZSBmaXJzdCBvY2N1cnJlbmNlIG9mIGFuXG4gIC8vIGl0ZW0gaW4gYW4gYXJyYXksIG9yIC0xIGlmIHRoZSBpdGVtIGlzIG5vdCBpbmNsdWRlZCBpbiB0aGUgYXJyYXkuXG4gIC8vIERlbGVnYXRlcyB0byAqKkVDTUFTY3JpcHQgNSoqJ3MgbmF0aXZlIGBpbmRleE9mYCBpZiBhdmFpbGFibGUuXG4gIC8vIElmIHRoZSBhcnJheSBpcyBsYXJnZSBhbmQgYWxyZWFkeSBpbiBzb3J0IG9yZGVyLCBwYXNzIGB0cnVlYFxuICAvLyBmb3IgKippc1NvcnRlZCoqIHRvIHVzZSBiaW5hcnkgc2VhcmNoLlxuICBfLmluZGV4T2YgPSBmdW5jdGlvbihhcnJheSwgaXRlbSwgaXNTb3J0ZWQpIHtcbiAgICBpZiAoYXJyYXkgPT0gbnVsbCkgcmV0dXJuIC0xO1xuICAgIHZhciBpID0gMCwgbGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xuICAgIGlmIChpc1NvcnRlZCkge1xuICAgICAgaWYgKHR5cGVvZiBpc1NvcnRlZCA9PSAnbnVtYmVyJykge1xuICAgICAgICBpID0gKGlzU29ydGVkIDwgMCA/IE1hdGgubWF4KDAsIGxlbmd0aCArIGlzU29ydGVkKSA6IGlzU29ydGVkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGkgPSBfLnNvcnRlZEluZGV4KGFycmF5LCBpdGVtKTtcbiAgICAgICAgcmV0dXJuIGFycmF5W2ldID09PSBpdGVtID8gaSA6IC0xO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAobmF0aXZlSW5kZXhPZiAmJiBhcnJheS5pbmRleE9mID09PSBuYXRpdmVJbmRleE9mKSByZXR1cm4gYXJyYXkuaW5kZXhPZihpdGVtLCBpc1NvcnRlZCk7XG4gICAgZm9yICg7IGkgPCBsZW5ndGg7IGkrKykgaWYgKGFycmF5W2ldID09PSBpdGVtKSByZXR1cm4gaTtcbiAgICByZXR1cm4gLTE7XG4gIH07XG5cbiAgLy8gRGVsZWdhdGVzIHRvICoqRUNNQVNjcmlwdCA1KioncyBuYXRpdmUgYGxhc3RJbmRleE9mYCBpZiBhdmFpbGFibGUuXG4gIF8ubGFzdEluZGV4T2YgPSBmdW5jdGlvbihhcnJheSwgaXRlbSwgZnJvbSkge1xuICAgIGlmIChhcnJheSA9PSBudWxsKSByZXR1cm4gLTE7XG4gICAgdmFyIGhhc0luZGV4ID0gZnJvbSAhPSBudWxsO1xuICAgIGlmIChuYXRpdmVMYXN0SW5kZXhPZiAmJiBhcnJheS5sYXN0SW5kZXhPZiA9PT0gbmF0aXZlTGFzdEluZGV4T2YpIHtcbiAgICAgIHJldHVybiBoYXNJbmRleCA/IGFycmF5Lmxhc3RJbmRleE9mKGl0ZW0sIGZyb20pIDogYXJyYXkubGFzdEluZGV4T2YoaXRlbSk7XG4gICAgfVxuICAgIHZhciBpID0gKGhhc0luZGV4ID8gZnJvbSA6IGFycmF5Lmxlbmd0aCk7XG4gICAgd2hpbGUgKGktLSkgaWYgKGFycmF5W2ldID09PSBpdGVtKSByZXR1cm4gaTtcbiAgICByZXR1cm4gLTE7XG4gIH07XG5cbiAgLy8gR2VuZXJhdGUgYW4gaW50ZWdlciBBcnJheSBjb250YWluaW5nIGFuIGFyaXRobWV0aWMgcHJvZ3Jlc3Npb24uIEEgcG9ydCBvZlxuICAvLyB0aGUgbmF0aXZlIFB5dGhvbiBgcmFuZ2UoKWAgZnVuY3Rpb24uIFNlZVxuICAvLyBbdGhlIFB5dGhvbiBkb2N1bWVudGF0aW9uXShodHRwOi8vZG9jcy5weXRob24ub3JnL2xpYnJhcnkvZnVuY3Rpb25zLmh0bWwjcmFuZ2UpLlxuICBfLnJhbmdlID0gZnVuY3Rpb24oc3RhcnQsIHN0b3AsIHN0ZXApIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA8PSAxKSB7XG4gICAgICBzdG9wID0gc3RhcnQgfHwgMDtcbiAgICAgIHN0YXJ0ID0gMDtcbiAgICB9XG4gICAgc3RlcCA9IGFyZ3VtZW50c1syXSB8fCAxO1xuXG4gICAgdmFyIGxlbmd0aCA9IE1hdGgubWF4KE1hdGguY2VpbCgoc3RvcCAtIHN0YXJ0KSAvIHN0ZXApLCAwKTtcbiAgICB2YXIgaWR4ID0gMDtcbiAgICB2YXIgcmFuZ2UgPSBuZXcgQXJyYXkobGVuZ3RoKTtcblxuICAgIHdoaWxlKGlkeCA8IGxlbmd0aCkge1xuICAgICAgcmFuZ2VbaWR4KytdID0gc3RhcnQ7XG4gICAgICBzdGFydCArPSBzdGVwO1xuICAgIH1cblxuICAgIHJldHVybiByYW5nZTtcbiAgfTtcblxuICAvLyBGdW5jdGlvbiAoYWhlbSkgRnVuY3Rpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8vIFJldXNhYmxlIGNvbnN0cnVjdG9yIGZ1bmN0aW9uIGZvciBwcm90b3R5cGUgc2V0dGluZy5cbiAgdmFyIGN0b3IgPSBmdW5jdGlvbigpe307XG5cbiAgLy8gQ3JlYXRlIGEgZnVuY3Rpb24gYm91bmQgdG8gYSBnaXZlbiBvYmplY3QgKGFzc2lnbmluZyBgdGhpc2AsIGFuZCBhcmd1bWVudHMsXG4gIC8vIG9wdGlvbmFsbHkpLiBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgRnVuY3Rpb24uYmluZGAgaWZcbiAgLy8gYXZhaWxhYmxlLlxuICBfLmJpbmQgPSBmdW5jdGlvbihmdW5jLCBjb250ZXh0KSB7XG4gICAgdmFyIGFyZ3MsIGJvdW5kO1xuICAgIGlmIChuYXRpdmVCaW5kICYmIGZ1bmMuYmluZCA9PT0gbmF0aXZlQmluZCkgcmV0dXJuIG5hdGl2ZUJpbmQuYXBwbHkoZnVuYywgc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgICBpZiAoIV8uaXNGdW5jdGlvbihmdW5jKSkgdGhyb3cgbmV3IFR5cGVFcnJvcjtcbiAgICBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDIpO1xuICAgIHJldHVybiBib3VuZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIGJvdW5kKSkgcmV0dXJuIGZ1bmMuYXBwbHkoY29udGV4dCwgYXJncy5jb25jYXQoc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gICAgICBjdG9yLnByb3RvdHlwZSA9IGZ1bmMucHJvdG90eXBlO1xuICAgICAgdmFyIHNlbGYgPSBuZXcgY3RvcjtcbiAgICAgIGN0b3IucHJvdG90eXBlID0gbnVsbDtcbiAgICAgIHZhciByZXN1bHQgPSBmdW5jLmFwcGx5KHNlbGYsIGFyZ3MuY29uY2F0KHNsaWNlLmNhbGwoYXJndW1lbnRzKSkpO1xuICAgICAgaWYgKE9iamVjdChyZXN1bHQpID09PSByZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICByZXR1cm4gc2VsZjtcbiAgICB9O1xuICB9O1xuXG4gIC8vIFBhcnRpYWxseSBhcHBseSBhIGZ1bmN0aW9uIGJ5IGNyZWF0aW5nIGEgdmVyc2lvbiB0aGF0IGhhcyBoYWQgc29tZSBvZiBpdHNcbiAgLy8gYXJndW1lbnRzIHByZS1maWxsZWQsIHdpdGhvdXQgY2hhbmdpbmcgaXRzIGR5bmFtaWMgYHRoaXNgIGNvbnRleHQuXG4gIF8ucGFydGlhbCA9IGZ1bmN0aW9uKGZ1bmMpIHtcbiAgICB2YXIgYXJncyA9IHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKTtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gZnVuYy5hcHBseSh0aGlzLCBhcmdzLmNvbmNhdChzbGljZS5jYWxsKGFyZ3VtZW50cykpKTtcbiAgICB9O1xuICB9O1xuXG4gIC8vIEJpbmQgYWxsIG9mIGFuIG9iamVjdCdzIG1ldGhvZHMgdG8gdGhhdCBvYmplY3QuIFVzZWZ1bCBmb3IgZW5zdXJpbmcgdGhhdFxuICAvLyBhbGwgY2FsbGJhY2tzIGRlZmluZWQgb24gYW4gb2JqZWN0IGJlbG9uZyB0byBpdC5cbiAgXy5iaW5kQWxsID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIGZ1bmNzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgIGlmIChmdW5jcy5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcihcImJpbmRBbGwgbXVzdCBiZSBwYXNzZWQgZnVuY3Rpb24gbmFtZXNcIik7XG4gICAgZWFjaChmdW5jcywgZnVuY3Rpb24oZikgeyBvYmpbZl0gPSBfLmJpbmQob2JqW2ZdLCBvYmopOyB9KTtcbiAgICByZXR1cm4gb2JqO1xuICB9O1xuXG4gIC8vIE1lbW9pemUgYW4gZXhwZW5zaXZlIGZ1bmN0aW9uIGJ5IHN0b3JpbmcgaXRzIHJlc3VsdHMuXG4gIF8ubWVtb2l6ZSA9IGZ1bmN0aW9uKGZ1bmMsIGhhc2hlcikge1xuICAgIHZhciBtZW1vID0ge307XG4gICAgaGFzaGVyIHx8IChoYXNoZXIgPSBfLmlkZW50aXR5KTtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIga2V5ID0gaGFzaGVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICByZXR1cm4gXy5oYXMobWVtbywga2V5KSA/IG1lbW9ba2V5XSA6IChtZW1vW2tleV0gPSBmdW5jLmFwcGx5KHRoaXMsIGFyZ3VtZW50cykpO1xuICAgIH07XG4gIH07XG5cbiAgLy8gRGVsYXlzIGEgZnVuY3Rpb24gZm9yIHRoZSBnaXZlbiBudW1iZXIgb2YgbWlsbGlzZWNvbmRzLCBhbmQgdGhlbiBjYWxsc1xuICAvLyBpdCB3aXRoIHRoZSBhcmd1bWVudHMgc3VwcGxpZWQuXG4gIF8uZGVsYXkgPSBmdW5jdGlvbihmdW5jLCB3YWl0KSB7XG4gICAgdmFyIGFyZ3MgPSBzbGljZS5jYWxsKGFyZ3VtZW50cywgMik7XG4gICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuY3Rpb24oKXsgcmV0dXJuIGZ1bmMuYXBwbHkobnVsbCwgYXJncyk7IH0sIHdhaXQpO1xuICB9O1xuXG4gIC8vIERlZmVycyBhIGZ1bmN0aW9uLCBzY2hlZHVsaW5nIGl0IHRvIHJ1biBhZnRlciB0aGUgY3VycmVudCBjYWxsIHN0YWNrIGhhc1xuICAvLyBjbGVhcmVkLlxuICBfLmRlZmVyID0gZnVuY3Rpb24oZnVuYykge1xuICAgIHJldHVybiBfLmRlbGF5LmFwcGx5KF8sIFtmdW5jLCAxXS5jb25jYXQoc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKSk7XG4gIH07XG5cbiAgLy8gUmV0dXJucyBhIGZ1bmN0aW9uLCB0aGF0LCB3aGVuIGludm9rZWQsIHdpbGwgb25seSBiZSB0cmlnZ2VyZWQgYXQgbW9zdCBvbmNlXG4gIC8vIGR1cmluZyBhIGdpdmVuIHdpbmRvdyBvZiB0aW1lLiBOb3JtYWxseSwgdGhlIHRocm90dGxlZCBmdW5jdGlvbiB3aWxsIHJ1blxuICAvLyBhcyBtdWNoIGFzIGl0IGNhbiwgd2l0aG91dCBldmVyIGdvaW5nIG1vcmUgdGhhbiBvbmNlIHBlciBgd2FpdGAgZHVyYXRpb247XG4gIC8vIGJ1dCBpZiB5b3UnZCBsaWtlIHRvIGRpc2FibGUgdGhlIGV4ZWN1dGlvbiBvbiB0aGUgbGVhZGluZyBlZGdlLCBwYXNzXG4gIC8vIGB7bGVhZGluZzogZmFsc2V9YC4gVG8gZGlzYWJsZSBleGVjdXRpb24gb24gdGhlIHRyYWlsaW5nIGVkZ2UsIGRpdHRvLlxuICBfLnRocm90dGxlID0gZnVuY3Rpb24oZnVuYywgd2FpdCwgb3B0aW9ucykge1xuICAgIHZhciBjb250ZXh0LCBhcmdzLCByZXN1bHQ7XG4gICAgdmFyIHRpbWVvdXQgPSBudWxsO1xuICAgIHZhciBwcmV2aW91cyA9IDA7XG4gICAgb3B0aW9ucyB8fCAob3B0aW9ucyA9IHt9KTtcbiAgICB2YXIgbGF0ZXIgPSBmdW5jdGlvbigpIHtcbiAgICAgIHByZXZpb3VzID0gb3B0aW9ucy5sZWFkaW5nID09PSBmYWxzZSA/IDAgOiBuZXcgRGF0ZTtcbiAgICAgIHRpbWVvdXQgPSBudWxsO1xuICAgICAgcmVzdWx0ID0gZnVuYy5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICB9O1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBub3cgPSBuZXcgRGF0ZTtcbiAgICAgIGlmICghcHJldmlvdXMgJiYgb3B0aW9ucy5sZWFkaW5nID09PSBmYWxzZSkgcHJldmlvdXMgPSBub3c7XG4gICAgICB2YXIgcmVtYWluaW5nID0gd2FpdCAtIChub3cgLSBwcmV2aW91cyk7XG4gICAgICBjb250ZXh0ID0gdGhpcztcbiAgICAgIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICBpZiAocmVtYWluaW5nIDw9IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICB0aW1lb3V0ID0gbnVsbDtcbiAgICAgICAgcHJldmlvdXMgPSBub3c7XG4gICAgICAgIHJlc3VsdCA9IGZ1bmMuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICB9IGVsc2UgaWYgKCF0aW1lb3V0ICYmIG9wdGlvbnMudHJhaWxpbmcgIT09IGZhbHNlKSB7XG4gICAgICAgIHRpbWVvdXQgPSBzZXRUaW1lb3V0KGxhdGVyLCByZW1haW5pbmcpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9O1xuICB9O1xuXG4gIC8vIFJldHVybnMgYSBmdW5jdGlvbiwgdGhhdCwgYXMgbG9uZyBhcyBpdCBjb250aW51ZXMgdG8gYmUgaW52b2tlZCwgd2lsbCBub3RcbiAgLy8gYmUgdHJpZ2dlcmVkLiBUaGUgZnVuY3Rpb24gd2lsbCBiZSBjYWxsZWQgYWZ0ZXIgaXQgc3RvcHMgYmVpbmcgY2FsbGVkIGZvclxuICAvLyBOIG1pbGxpc2Vjb25kcy4gSWYgYGltbWVkaWF0ZWAgaXMgcGFzc2VkLCB0cmlnZ2VyIHRoZSBmdW5jdGlvbiBvbiB0aGVcbiAgLy8gbGVhZGluZyBlZGdlLCBpbnN0ZWFkIG9mIHRoZSB0cmFpbGluZy5cbiAgXy5kZWJvdW5jZSA9IGZ1bmN0aW9uKGZ1bmMsIHdhaXQsIGltbWVkaWF0ZSkge1xuICAgIHZhciB0aW1lb3V0LCBhcmdzLCBjb250ZXh0LCB0aW1lc3RhbXAsIHJlc3VsdDtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICBjb250ZXh0ID0gdGhpcztcbiAgICAgIGFyZ3MgPSBhcmd1bWVudHM7XG4gICAgICB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpO1xuICAgICAgdmFyIGxhdGVyID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBsYXN0ID0gKG5ldyBEYXRlKCkpIC0gdGltZXN0YW1wO1xuICAgICAgICBpZiAobGFzdCA8IHdhaXQpIHtcbiAgICAgICAgICB0aW1lb3V0ID0gc2V0VGltZW91dChsYXRlciwgd2FpdCAtIGxhc3QpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRpbWVvdXQgPSBudWxsO1xuICAgICAgICAgIGlmICghaW1tZWRpYXRlKSByZXN1bHQgPSBmdW5jLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgdmFyIGNhbGxOb3cgPSBpbW1lZGlhdGUgJiYgIXRpbWVvdXQ7XG4gICAgICBpZiAoIXRpbWVvdXQpIHtcbiAgICAgICAgdGltZW91dCA9IHNldFRpbWVvdXQobGF0ZXIsIHdhaXQpO1xuICAgICAgfVxuICAgICAgaWYgKGNhbGxOb3cpIHJlc3VsdCA9IGZ1bmMuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG4gIH07XG5cbiAgLy8gUmV0dXJucyBhIGZ1bmN0aW9uIHRoYXQgd2lsbCBiZSBleGVjdXRlZCBhdCBtb3N0IG9uZSB0aW1lLCBubyBtYXR0ZXIgaG93XG4gIC8vIG9mdGVuIHlvdSBjYWxsIGl0LiBVc2VmdWwgZm9yIGxhenkgaW5pdGlhbGl6YXRpb24uXG4gIF8ub25jZSA9IGZ1bmN0aW9uKGZ1bmMpIHtcbiAgICB2YXIgcmFuID0gZmFsc2UsIG1lbW87XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKHJhbikgcmV0dXJuIG1lbW87XG4gICAgICByYW4gPSB0cnVlO1xuICAgICAgbWVtbyA9IGZ1bmMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgIGZ1bmMgPSBudWxsO1xuICAgICAgcmV0dXJuIG1lbW87XG4gICAgfTtcbiAgfTtcblxuICAvLyBSZXR1cm5zIHRoZSBmaXJzdCBmdW5jdGlvbiBwYXNzZWQgYXMgYW4gYXJndW1lbnQgdG8gdGhlIHNlY29uZCxcbiAgLy8gYWxsb3dpbmcgeW91IHRvIGFkanVzdCBhcmd1bWVudHMsIHJ1biBjb2RlIGJlZm9yZSBhbmQgYWZ0ZXIsIGFuZFxuICAvLyBjb25kaXRpb25hbGx5IGV4ZWN1dGUgdGhlIG9yaWdpbmFsIGZ1bmN0aW9uLlxuICBfLndyYXAgPSBmdW5jdGlvbihmdW5jLCB3cmFwcGVyKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGFyZ3MgPSBbZnVuY107XG4gICAgICBwdXNoLmFwcGx5KGFyZ3MsIGFyZ3VtZW50cyk7XG4gICAgICByZXR1cm4gd3JhcHBlci5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICB9O1xuICB9O1xuXG4gIC8vIFJldHVybnMgYSBmdW5jdGlvbiB0aGF0IGlzIHRoZSBjb21wb3NpdGlvbiBvZiBhIGxpc3Qgb2YgZnVuY3Rpb25zLCBlYWNoXG4gIC8vIGNvbnN1bWluZyB0aGUgcmV0dXJuIHZhbHVlIG9mIHRoZSBmdW5jdGlvbiB0aGF0IGZvbGxvd3MuXG4gIF8uY29tcG9zZSA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBmdW5jcyA9IGFyZ3VtZW50cztcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgICAgIGZvciAodmFyIGkgPSBmdW5jcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICBhcmdzID0gW2Z1bmNzW2ldLmFwcGx5KHRoaXMsIGFyZ3MpXTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhcmdzWzBdO1xuICAgIH07XG4gIH07XG5cbiAgLy8gUmV0dXJucyBhIGZ1bmN0aW9uIHRoYXQgd2lsbCBvbmx5IGJlIGV4ZWN1dGVkIGFmdGVyIGJlaW5nIGNhbGxlZCBOIHRpbWVzLlxuICBfLmFmdGVyID0gZnVuY3Rpb24odGltZXMsIGZ1bmMpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoLS10aW1lcyA8IDEpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgIH1cbiAgICB9O1xuICB9O1xuXG4gIC8vIE9iamVjdCBGdW5jdGlvbnNcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8vIFJldHJpZXZlIHRoZSBuYW1lcyBvZiBhbiBvYmplY3QncyBwcm9wZXJ0aWVzLlxuICAvLyBEZWxlZ2F0ZXMgdG8gKipFQ01BU2NyaXB0IDUqKidzIG5hdGl2ZSBgT2JqZWN0LmtleXNgXG4gIF8ua2V5cyA9IG5hdGl2ZUtleXMgfHwgZnVuY3Rpb24ob2JqKSB7XG4gICAgaWYgKG9iaiAhPT0gT2JqZWN0KG9iaikpIHRocm93IG5ldyBUeXBlRXJyb3IoJ0ludmFsaWQgb2JqZWN0Jyk7XG4gICAgdmFyIGtleXMgPSBbXTtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqKSBpZiAoXy5oYXMob2JqLCBrZXkpKSBrZXlzLnB1c2goa2V5KTtcbiAgICByZXR1cm4ga2V5cztcbiAgfTtcblxuICAvLyBSZXRyaWV2ZSB0aGUgdmFsdWVzIG9mIGFuIG9iamVjdCdzIHByb3BlcnRpZXMuXG4gIF8udmFsdWVzID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIGtleXMgPSBfLmtleXMob2JqKTtcbiAgICB2YXIgbGVuZ3RoID0ga2V5cy5sZW5ndGg7XG4gICAgdmFyIHZhbHVlcyA9IG5ldyBBcnJheShsZW5ndGgpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICAgIHZhbHVlc1tpXSA9IG9ialtrZXlzW2ldXTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlcztcbiAgfTtcblxuICAvLyBDb252ZXJ0IGFuIG9iamVjdCBpbnRvIGEgbGlzdCBvZiBgW2tleSwgdmFsdWVdYCBwYWlycy5cbiAgXy5wYWlycyA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciBrZXlzID0gXy5rZXlzKG9iaik7XG4gICAgdmFyIGxlbmd0aCA9IGtleXMubGVuZ3RoO1xuICAgIHZhciBwYWlycyA9IG5ldyBBcnJheShsZW5ndGgpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICAgIHBhaXJzW2ldID0gW2tleXNbaV0sIG9ialtrZXlzW2ldXV07XG4gICAgfVxuICAgIHJldHVybiBwYWlycztcbiAgfTtcblxuICAvLyBJbnZlcnQgdGhlIGtleXMgYW5kIHZhbHVlcyBvZiBhbiBvYmplY3QuIFRoZSB2YWx1ZXMgbXVzdCBiZSBzZXJpYWxpemFibGUuXG4gIF8uaW52ZXJ0ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIHJlc3VsdCA9IHt9O1xuICAgIHZhciBrZXlzID0gXy5rZXlzKG9iaik7XG4gICAgZm9yICh2YXIgaSA9IDAsIGxlbmd0aCA9IGtleXMubGVuZ3RoOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICAgIHJlc3VsdFtvYmpba2V5c1tpXV1dID0ga2V5c1tpXTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfTtcblxuICAvLyBSZXR1cm4gYSBzb3J0ZWQgbGlzdCBvZiB0aGUgZnVuY3Rpb24gbmFtZXMgYXZhaWxhYmxlIG9uIHRoZSBvYmplY3QuXG4gIC8vIEFsaWFzZWQgYXMgYG1ldGhvZHNgXG4gIF8uZnVuY3Rpb25zID0gXy5tZXRob2RzID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgdmFyIG5hbWVzID0gW107XG4gICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgaWYgKF8uaXNGdW5jdGlvbihvYmpba2V5XSkpIG5hbWVzLnB1c2goa2V5KTtcbiAgICB9XG4gICAgcmV0dXJuIG5hbWVzLnNvcnQoKTtcbiAgfTtcblxuICAvLyBFeHRlbmQgYSBnaXZlbiBvYmplY3Qgd2l0aCBhbGwgdGhlIHByb3BlcnRpZXMgaW4gcGFzc2VkLWluIG9iamVjdChzKS5cbiAgXy5leHRlbmQgPSBmdW5jdGlvbihvYmopIHtcbiAgICBlYWNoKHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSwgZnVuY3Rpb24oc291cmNlKSB7XG4gICAgICBpZiAoc291cmNlKSB7XG4gICAgICAgIGZvciAodmFyIHByb3AgaW4gc291cmNlKSB7XG4gICAgICAgICAgb2JqW3Byb3BdID0gc291cmNlW3Byb3BdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIG9iajtcbiAgfTtcblxuICAvLyBSZXR1cm4gYSBjb3B5IG9mIHRoZSBvYmplY3Qgb25seSBjb250YWluaW5nIHRoZSB3aGl0ZWxpc3RlZCBwcm9wZXJ0aWVzLlxuICBfLnBpY2sgPSBmdW5jdGlvbihvYmopIHtcbiAgICB2YXIgY29weSA9IHt9O1xuICAgIHZhciBrZXlzID0gY29uY2F0LmFwcGx5KEFycmF5UHJvdG8sIHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSk7XG4gICAgZWFjaChrZXlzLCBmdW5jdGlvbihrZXkpIHtcbiAgICAgIGlmIChrZXkgaW4gb2JqKSBjb3B5W2tleV0gPSBvYmpba2V5XTtcbiAgICB9KTtcbiAgICByZXR1cm4gY29weTtcbiAgfTtcblxuICAgLy8gUmV0dXJuIGEgY29weSBvZiB0aGUgb2JqZWN0IHdpdGhvdXQgdGhlIGJsYWNrbGlzdGVkIHByb3BlcnRpZXMuXG4gIF8ub21pdCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHZhciBjb3B5ID0ge307XG4gICAgdmFyIGtleXMgPSBjb25jYXQuYXBwbHkoQXJyYXlQcm90bywgc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgICBpZiAoIV8uY29udGFpbnMoa2V5cywga2V5KSkgY29weVtrZXldID0gb2JqW2tleV07XG4gICAgfVxuICAgIHJldHVybiBjb3B5O1xuICB9O1xuXG4gIC8vIEZpbGwgaW4gYSBnaXZlbiBvYmplY3Qgd2l0aCBkZWZhdWx0IHByb3BlcnRpZXMuXG4gIF8uZGVmYXVsdHMgPSBmdW5jdGlvbihvYmopIHtcbiAgICBlYWNoKHNsaWNlLmNhbGwoYXJndW1lbnRzLCAxKSwgZnVuY3Rpb24oc291cmNlKSB7XG4gICAgICBpZiAoc291cmNlKSB7XG4gICAgICAgIGZvciAodmFyIHByb3AgaW4gc291cmNlKSB7XG4gICAgICAgICAgaWYgKG9ialtwcm9wXSA9PT0gdm9pZCAwKSBvYmpbcHJvcF0gPSBzb3VyY2VbcHJvcF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gb2JqO1xuICB9O1xuXG4gIC8vIENyZWF0ZSBhIChzaGFsbG93LWNsb25lZCkgZHVwbGljYXRlIG9mIGFuIG9iamVjdC5cbiAgXy5jbG9uZSA9IGZ1bmN0aW9uKG9iaikge1xuICAgIGlmICghXy5pc09iamVjdChvYmopKSByZXR1cm4gb2JqO1xuICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/IG9iai5zbGljZSgpIDogXy5leHRlbmQoe30sIG9iaik7XG4gIH07XG5cbiAgLy8gSW52b2tlcyBpbnRlcmNlcHRvciB3aXRoIHRoZSBvYmosIGFuZCB0aGVuIHJldHVybnMgb2JqLlxuICAvLyBUaGUgcHJpbWFyeSBwdXJwb3NlIG9mIHRoaXMgbWV0aG9kIGlzIHRvIFwidGFwIGludG9cIiBhIG1ldGhvZCBjaGFpbiwgaW5cbiAgLy8gb3JkZXIgdG8gcGVyZm9ybSBvcGVyYXRpb25zIG9uIGludGVybWVkaWF0ZSByZXN1bHRzIHdpdGhpbiB0aGUgY2hhaW4uXG4gIF8udGFwID0gZnVuY3Rpb24ob2JqLCBpbnRlcmNlcHRvcikge1xuICAgIGludGVyY2VwdG9yKG9iaik7XG4gICAgcmV0dXJuIG9iajtcbiAgfTtcblxuICAvLyBJbnRlcm5hbCByZWN1cnNpdmUgY29tcGFyaXNvbiBmdW5jdGlvbiBmb3IgYGlzRXF1YWxgLlxuICB2YXIgZXEgPSBmdW5jdGlvbihhLCBiLCBhU3RhY2ssIGJTdGFjaykge1xuICAgIC8vIElkZW50aWNhbCBvYmplY3RzIGFyZSBlcXVhbC4gYDAgPT09IC0wYCwgYnV0IHRoZXkgYXJlbid0IGlkZW50aWNhbC5cbiAgICAvLyBTZWUgdGhlIFtIYXJtb255IGBlZ2FsYCBwcm9wb3NhbF0oaHR0cDovL3dpa2kuZWNtYXNjcmlwdC5vcmcvZG9rdS5waHA/aWQ9aGFybW9ueTplZ2FsKS5cbiAgICBpZiAoYSA9PT0gYikgcmV0dXJuIGEgIT09IDAgfHwgMSAvIGEgPT0gMSAvIGI7XG4gICAgLy8gQSBzdHJpY3QgY29tcGFyaXNvbiBpcyBuZWNlc3NhcnkgYmVjYXVzZSBgbnVsbCA9PSB1bmRlZmluZWRgLlxuICAgIGlmIChhID09IG51bGwgfHwgYiA9PSBudWxsKSByZXR1cm4gYSA9PT0gYjtcbiAgICAvLyBVbndyYXAgYW55IHdyYXBwZWQgb2JqZWN0cy5cbiAgICBpZiAoYSBpbnN0YW5jZW9mIF8pIGEgPSBhLl93cmFwcGVkO1xuICAgIGlmIChiIGluc3RhbmNlb2YgXykgYiA9IGIuX3dyYXBwZWQ7XG4gICAgLy8gQ29tcGFyZSBgW1tDbGFzc11dYCBuYW1lcy5cbiAgICB2YXIgY2xhc3NOYW1lID0gdG9TdHJpbmcuY2FsbChhKTtcbiAgICBpZiAoY2xhc3NOYW1lICE9IHRvU3RyaW5nLmNhbGwoYikpIHJldHVybiBmYWxzZTtcbiAgICBzd2l0Y2ggKGNsYXNzTmFtZSkge1xuICAgICAgLy8gU3RyaW5ncywgbnVtYmVycywgZGF0ZXMsIGFuZCBib29sZWFucyBhcmUgY29tcGFyZWQgYnkgdmFsdWUuXG4gICAgICBjYXNlICdbb2JqZWN0IFN0cmluZ10nOlxuICAgICAgICAvLyBQcmltaXRpdmVzIGFuZCB0aGVpciBjb3JyZXNwb25kaW5nIG9iamVjdCB3cmFwcGVycyBhcmUgZXF1aXZhbGVudDsgdGh1cywgYFwiNVwiYCBpc1xuICAgICAgICAvLyBlcXVpdmFsZW50IHRvIGBuZXcgU3RyaW5nKFwiNVwiKWAuXG4gICAgICAgIHJldHVybiBhID09IFN0cmluZyhiKTtcbiAgICAgIGNhc2UgJ1tvYmplY3QgTnVtYmVyXSc6XG4gICAgICAgIC8vIGBOYU5gcyBhcmUgZXF1aXZhbGVudCwgYnV0IG5vbi1yZWZsZXhpdmUuIEFuIGBlZ2FsYCBjb21wYXJpc29uIGlzIHBlcmZvcm1lZCBmb3JcbiAgICAgICAgLy8gb3RoZXIgbnVtZXJpYyB2YWx1ZXMuXG4gICAgICAgIHJldHVybiBhICE9ICthID8gYiAhPSArYiA6IChhID09IDAgPyAxIC8gYSA9PSAxIC8gYiA6IGEgPT0gK2IpO1xuICAgICAgY2FzZSAnW29iamVjdCBEYXRlXSc6XG4gICAgICBjYXNlICdbb2JqZWN0IEJvb2xlYW5dJzpcbiAgICAgICAgLy8gQ29lcmNlIGRhdGVzIGFuZCBib29sZWFucyB0byBudW1lcmljIHByaW1pdGl2ZSB2YWx1ZXMuIERhdGVzIGFyZSBjb21wYXJlZCBieSB0aGVpclxuICAgICAgICAvLyBtaWxsaXNlY29uZCByZXByZXNlbnRhdGlvbnMuIE5vdGUgdGhhdCBpbnZhbGlkIGRhdGVzIHdpdGggbWlsbGlzZWNvbmQgcmVwcmVzZW50YXRpb25zXG4gICAgICAgIC8vIG9mIGBOYU5gIGFyZSBub3QgZXF1aXZhbGVudC5cbiAgICAgICAgcmV0dXJuICthID09ICtiO1xuICAgICAgLy8gUmVnRXhwcyBhcmUgY29tcGFyZWQgYnkgdGhlaXIgc291cmNlIHBhdHRlcm5zIGFuZCBmbGFncy5cbiAgICAgIGNhc2UgJ1tvYmplY3QgUmVnRXhwXSc6XG4gICAgICAgIHJldHVybiBhLnNvdXJjZSA9PSBiLnNvdXJjZSAmJlxuICAgICAgICAgICAgICAgYS5nbG9iYWwgPT0gYi5nbG9iYWwgJiZcbiAgICAgICAgICAgICAgIGEubXVsdGlsaW5lID09IGIubXVsdGlsaW5lICYmXG4gICAgICAgICAgICAgICBhLmlnbm9yZUNhc2UgPT0gYi5pZ25vcmVDYXNlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGEgIT0gJ29iamVjdCcgfHwgdHlwZW9mIGIgIT0gJ29iamVjdCcpIHJldHVybiBmYWxzZTtcbiAgICAvLyBBc3N1bWUgZXF1YWxpdHkgZm9yIGN5Y2xpYyBzdHJ1Y3R1cmVzLiBUaGUgYWxnb3JpdGhtIGZvciBkZXRlY3RpbmcgY3ljbGljXG4gICAgLy8gc3RydWN0dXJlcyBpcyBhZGFwdGVkIGZyb20gRVMgNS4xIHNlY3Rpb24gMTUuMTIuMywgYWJzdHJhY3Qgb3BlcmF0aW9uIGBKT2AuXG4gICAgdmFyIGxlbmd0aCA9IGFTdGFjay5sZW5ndGg7XG4gICAgd2hpbGUgKGxlbmd0aC0tKSB7XG4gICAgICAvLyBMaW5lYXIgc2VhcmNoLiBQZXJmb3JtYW5jZSBpcyBpbnZlcnNlbHkgcHJvcG9ydGlvbmFsIHRvIHRoZSBudW1iZXIgb2ZcbiAgICAgIC8vIHVuaXF1ZSBuZXN0ZWQgc3RydWN0dXJlcy5cbiAgICAgIGlmIChhU3RhY2tbbGVuZ3RoXSA9PSBhKSByZXR1cm4gYlN0YWNrW2xlbmd0aF0gPT0gYjtcbiAgICB9XG4gICAgLy8gT2JqZWN0cyB3aXRoIGRpZmZlcmVudCBjb25zdHJ1Y3RvcnMgYXJlIG5vdCBlcXVpdmFsZW50LCBidXQgYE9iamVjdGBzXG4gICAgLy8gZnJvbSBkaWZmZXJlbnQgZnJhbWVzIGFyZS5cbiAgICB2YXIgYUN0b3IgPSBhLmNvbnN0cnVjdG9yLCBiQ3RvciA9IGIuY29uc3RydWN0b3I7XG4gICAgaWYgKGFDdG9yICE9PSBiQ3RvciAmJiAhKF8uaXNGdW5jdGlvbihhQ3RvcikgJiYgKGFDdG9yIGluc3RhbmNlb2YgYUN0b3IpICYmXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIF8uaXNGdW5jdGlvbihiQ3RvcikgJiYgKGJDdG9yIGluc3RhbmNlb2YgYkN0b3IpKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICAvLyBBZGQgdGhlIGZpcnN0IG9iamVjdCB0byB0aGUgc3RhY2sgb2YgdHJhdmVyc2VkIG9iamVjdHMuXG4gICAgYVN0YWNrLnB1c2goYSk7XG4gICAgYlN0YWNrLnB1c2goYik7XG4gICAgdmFyIHNpemUgPSAwLCByZXN1bHQgPSB0cnVlO1xuICAgIC8vIFJlY3Vyc2l2ZWx5IGNvbXBhcmUgb2JqZWN0cyBhbmQgYXJyYXlzLlxuICAgIGlmIChjbGFzc05hbWUgPT0gJ1tvYmplY3QgQXJyYXldJykge1xuICAgICAgLy8gQ29tcGFyZSBhcnJheSBsZW5ndGhzIHRvIGRldGVybWluZSBpZiBhIGRlZXAgY29tcGFyaXNvbiBpcyBuZWNlc3NhcnkuXG4gICAgICBzaXplID0gYS5sZW5ndGg7XG4gICAgICByZXN1bHQgPSBzaXplID09IGIubGVuZ3RoO1xuICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAvLyBEZWVwIGNvbXBhcmUgdGhlIGNvbnRlbnRzLCBpZ25vcmluZyBub24tbnVtZXJpYyBwcm9wZXJ0aWVzLlxuICAgICAgICB3aGlsZSAoc2l6ZS0tKSB7XG4gICAgICAgICAgaWYgKCEocmVzdWx0ID0gZXEoYVtzaXplXSwgYltzaXplXSwgYVN0YWNrLCBiU3RhY2spKSkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRGVlcCBjb21wYXJlIG9iamVjdHMuXG4gICAgICBmb3IgKHZhciBrZXkgaW4gYSkge1xuICAgICAgICBpZiAoXy5oYXMoYSwga2V5KSkge1xuICAgICAgICAgIC8vIENvdW50IHRoZSBleHBlY3RlZCBudW1iZXIgb2YgcHJvcGVydGllcy5cbiAgICAgICAgICBzaXplKys7XG4gICAgICAgICAgLy8gRGVlcCBjb21wYXJlIGVhY2ggbWVtYmVyLlxuICAgICAgICAgIGlmICghKHJlc3VsdCA9IF8uaGFzKGIsIGtleSkgJiYgZXEoYVtrZXldLCBiW2tleV0sIGFTdGFjaywgYlN0YWNrKSkpIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBFbnN1cmUgdGhhdCBib3RoIG9iamVjdHMgY29udGFpbiB0aGUgc2FtZSBudW1iZXIgb2YgcHJvcGVydGllcy5cbiAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgZm9yIChrZXkgaW4gYikge1xuICAgICAgICAgIGlmIChfLmhhcyhiLCBrZXkpICYmICEoc2l6ZS0tKSkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0ID0gIXNpemU7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFJlbW92ZSB0aGUgZmlyc3Qgb2JqZWN0IGZyb20gdGhlIHN0YWNrIG9mIHRyYXZlcnNlZCBvYmplY3RzLlxuICAgIGFTdGFjay5wb3AoKTtcbiAgICBiU3RhY2sucG9wKCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfTtcblxuICAvLyBQZXJmb3JtIGEgZGVlcCBjb21wYXJpc29uIHRvIGNoZWNrIGlmIHR3byBvYmplY3RzIGFyZSBlcXVhbC5cbiAgXy5pc0VxdWFsID0gZnVuY3Rpb24oYSwgYikge1xuICAgIHJldHVybiBlcShhLCBiLCBbXSwgW10pO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gYXJyYXksIHN0cmluZywgb3Igb2JqZWN0IGVtcHR5P1xuICAvLyBBbiBcImVtcHR5XCIgb2JqZWN0IGhhcyBubyBlbnVtZXJhYmxlIG93bi1wcm9wZXJ0aWVzLlxuICBfLmlzRW1wdHkgPSBmdW5jdGlvbihvYmopIHtcbiAgICBpZiAob2JqID09IG51bGwpIHJldHVybiB0cnVlO1xuICAgIGlmIChfLmlzQXJyYXkob2JqKSB8fCBfLmlzU3RyaW5nKG9iaikpIHJldHVybiBvYmoubGVuZ3RoID09PSAwO1xuICAgIGZvciAodmFyIGtleSBpbiBvYmopIGlmIChfLmhhcyhvYmosIGtleSkpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfTtcblxuICAvLyBJcyBhIGdpdmVuIHZhbHVlIGEgRE9NIGVsZW1lbnQ/XG4gIF8uaXNFbGVtZW50ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuICEhKG9iaiAmJiBvYmoubm9kZVR5cGUgPT09IDEpO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gdmFsdWUgYW4gYXJyYXk/XG4gIC8vIERlbGVnYXRlcyB0byBFQ01BNSdzIG5hdGl2ZSBBcnJheS5pc0FycmF5XG4gIF8uaXNBcnJheSA9IG5hdGl2ZUlzQXJyYXkgfHwgZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuIHRvU3RyaW5nLmNhbGwob2JqKSA9PSAnW29iamVjdCBBcnJheV0nO1xuICB9O1xuXG4gIC8vIElzIGEgZ2l2ZW4gdmFyaWFibGUgYW4gb2JqZWN0P1xuICBfLmlzT2JqZWN0ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuIG9iaiA9PT0gT2JqZWN0KG9iaik7XG4gIH07XG5cbiAgLy8gQWRkIHNvbWUgaXNUeXBlIG1ldGhvZHM6IGlzQXJndW1lbnRzLCBpc0Z1bmN0aW9uLCBpc1N0cmluZywgaXNOdW1iZXIsIGlzRGF0ZSwgaXNSZWdFeHAuXG4gIGVhY2goWydBcmd1bWVudHMnLCAnRnVuY3Rpb24nLCAnU3RyaW5nJywgJ051bWJlcicsICdEYXRlJywgJ1JlZ0V4cCddLCBmdW5jdGlvbihuYW1lKSB7XG4gICAgX1snaXMnICsgbmFtZV0gPSBmdW5jdGlvbihvYmopIHtcbiAgICAgIHJldHVybiB0b1N0cmluZy5jYWxsKG9iaikgPT0gJ1tvYmplY3QgJyArIG5hbWUgKyAnXSc7XG4gICAgfTtcbiAgfSk7XG5cbiAgLy8gRGVmaW5lIGEgZmFsbGJhY2sgdmVyc2lvbiBvZiB0aGUgbWV0aG9kIGluIGJyb3dzZXJzIChhaGVtLCBJRSksIHdoZXJlXG4gIC8vIHRoZXJlIGlzbid0IGFueSBpbnNwZWN0YWJsZSBcIkFyZ3VtZW50c1wiIHR5cGUuXG4gIGlmICghXy5pc0FyZ3VtZW50cyhhcmd1bWVudHMpKSB7XG4gICAgXy5pc0FyZ3VtZW50cyA9IGZ1bmN0aW9uKG9iaikge1xuICAgICAgcmV0dXJuICEhKG9iaiAmJiBfLmhhcyhvYmosICdjYWxsZWUnKSk7XG4gICAgfTtcbiAgfVxuXG4gIC8vIE9wdGltaXplIGBpc0Z1bmN0aW9uYCBpZiBhcHByb3ByaWF0ZS5cbiAgaWYgKHR5cGVvZiAoLy4vKSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIF8uaXNGdW5jdGlvbiA9IGZ1bmN0aW9uKG9iaikge1xuICAgICAgcmV0dXJuIHR5cGVvZiBvYmogPT09ICdmdW5jdGlvbic7XG4gICAgfTtcbiAgfVxuXG4gIC8vIElzIGEgZ2l2ZW4gb2JqZWN0IGEgZmluaXRlIG51bWJlcj9cbiAgXy5pc0Zpbml0ZSA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBpc0Zpbml0ZShvYmopICYmICFpc05hTihwYXJzZUZsb2F0KG9iaikpO1xuICB9O1xuXG4gIC8vIElzIHRoZSBnaXZlbiB2YWx1ZSBgTmFOYD8gKE5hTiBpcyB0aGUgb25seSBudW1iZXIgd2hpY2ggZG9lcyBub3QgZXF1YWwgaXRzZWxmKS5cbiAgXy5pc05hTiA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBfLmlzTnVtYmVyKG9iaikgJiYgb2JqICE9ICtvYmo7XG4gIH07XG5cbiAgLy8gSXMgYSBnaXZlbiB2YWx1ZSBhIGJvb2xlYW4/XG4gIF8uaXNCb29sZWFuID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuIG9iaiA9PT0gdHJ1ZSB8fCBvYmogPT09IGZhbHNlIHx8IHRvU3RyaW5nLmNhbGwob2JqKSA9PSAnW29iamVjdCBCb29sZWFuXSc7XG4gIH07XG5cbiAgLy8gSXMgYSBnaXZlbiB2YWx1ZSBlcXVhbCB0byBudWxsP1xuICBfLmlzTnVsbCA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBvYmogPT09IG51bGw7XG4gIH07XG5cbiAgLy8gSXMgYSBnaXZlbiB2YXJpYWJsZSB1bmRlZmluZWQ/XG4gIF8uaXNVbmRlZmluZWQgPSBmdW5jdGlvbihvYmopIHtcbiAgICByZXR1cm4gb2JqID09PSB2b2lkIDA7XG4gIH07XG5cbiAgLy8gU2hvcnRjdXQgZnVuY3Rpb24gZm9yIGNoZWNraW5nIGlmIGFuIG9iamVjdCBoYXMgYSBnaXZlbiBwcm9wZXJ0eSBkaXJlY3RseVxuICAvLyBvbiBpdHNlbGYgKGluIG90aGVyIHdvcmRzLCBub3Qgb24gYSBwcm90b3R5cGUpLlxuICBfLmhhcyA9IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgcmV0dXJuIGhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpO1xuICB9O1xuXG4gIC8vIFV0aWxpdHkgRnVuY3Rpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgLy8gUnVuIFVuZGVyc2NvcmUuanMgaW4gKm5vQ29uZmxpY3QqIG1vZGUsIHJldHVybmluZyB0aGUgYF9gIHZhcmlhYmxlIHRvIGl0c1xuICAvLyBwcmV2aW91cyBvd25lci4gUmV0dXJucyBhIHJlZmVyZW5jZSB0byB0aGUgVW5kZXJzY29yZSBvYmplY3QuXG4gIF8ubm9Db25mbGljdCA9IGZ1bmN0aW9uKCkge1xuICAgIHJvb3QuXyA9IHByZXZpb3VzVW5kZXJzY29yZTtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcblxuICAvLyBLZWVwIHRoZSBpZGVudGl0eSBmdW5jdGlvbiBhcm91bmQgZm9yIGRlZmF1bHQgaXRlcmF0b3JzLlxuICBfLmlkZW50aXR5ID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH07XG5cbiAgLy8gUnVuIGEgZnVuY3Rpb24gKipuKiogdGltZXMuXG4gIF8udGltZXMgPSBmdW5jdGlvbihuLCBpdGVyYXRvciwgY29udGV4dCkge1xuICAgIHZhciBhY2N1bSA9IEFycmF5KE1hdGgubWF4KDAsIG4pKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG47IGkrKykgYWNjdW1baV0gPSBpdGVyYXRvci5jYWxsKGNvbnRleHQsIGkpO1xuICAgIHJldHVybiBhY2N1bTtcbiAgfTtcblxuICAvLyBSZXR1cm4gYSByYW5kb20gaW50ZWdlciBiZXR3ZWVuIG1pbiBhbmQgbWF4IChpbmNsdXNpdmUpLlxuICBfLnJhbmRvbSA9IGZ1bmN0aW9uKG1pbiwgbWF4KSB7XG4gICAgaWYgKG1heCA9PSBudWxsKSB7XG4gICAgICBtYXggPSBtaW47XG4gICAgICBtaW4gPSAwO1xuICAgIH1cbiAgICByZXR1cm4gbWluICsgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKG1heCAtIG1pbiArIDEpKTtcbiAgfTtcblxuICAvLyBMaXN0IG9mIEhUTUwgZW50aXRpZXMgZm9yIGVzY2FwaW5nLlxuICB2YXIgZW50aXR5TWFwID0ge1xuICAgIGVzY2FwZToge1xuICAgICAgJyYnOiAnJmFtcDsnLFxuICAgICAgJzwnOiAnJmx0OycsXG4gICAgICAnPic6ICcmZ3Q7JyxcbiAgICAgICdcIic6ICcmcXVvdDsnLFxuICAgICAgXCInXCI6ICcmI3gyNzsnXG4gICAgfVxuICB9O1xuICBlbnRpdHlNYXAudW5lc2NhcGUgPSBfLmludmVydChlbnRpdHlNYXAuZXNjYXBlKTtcblxuICAvLyBSZWdleGVzIGNvbnRhaW5pbmcgdGhlIGtleXMgYW5kIHZhbHVlcyBsaXN0ZWQgaW1tZWRpYXRlbHkgYWJvdmUuXG4gIHZhciBlbnRpdHlSZWdleGVzID0ge1xuICAgIGVzY2FwZTogICBuZXcgUmVnRXhwKCdbJyArIF8ua2V5cyhlbnRpdHlNYXAuZXNjYXBlKS5qb2luKCcnKSArICddJywgJ2cnKSxcbiAgICB1bmVzY2FwZTogbmV3IFJlZ0V4cCgnKCcgKyBfLmtleXMoZW50aXR5TWFwLnVuZXNjYXBlKS5qb2luKCd8JykgKyAnKScsICdnJylcbiAgfTtcblxuICAvLyBGdW5jdGlvbnMgZm9yIGVzY2FwaW5nIGFuZCB1bmVzY2FwaW5nIHN0cmluZ3MgdG8vZnJvbSBIVE1MIGludGVycG9sYXRpb24uXG4gIF8uZWFjaChbJ2VzY2FwZScsICd1bmVzY2FwZSddLCBmdW5jdGlvbihtZXRob2QpIHtcbiAgICBfW21ldGhvZF0gPSBmdW5jdGlvbihzdHJpbmcpIHtcbiAgICAgIGlmIChzdHJpbmcgPT0gbnVsbCkgcmV0dXJuICcnO1xuICAgICAgcmV0dXJuICgnJyArIHN0cmluZykucmVwbGFjZShlbnRpdHlSZWdleGVzW21ldGhvZF0sIGZ1bmN0aW9uKG1hdGNoKSB7XG4gICAgICAgIHJldHVybiBlbnRpdHlNYXBbbWV0aG9kXVttYXRjaF07XG4gICAgICB9KTtcbiAgICB9O1xuICB9KTtcblxuICAvLyBJZiB0aGUgdmFsdWUgb2YgdGhlIG5hbWVkIGBwcm9wZXJ0eWAgaXMgYSBmdW5jdGlvbiB0aGVuIGludm9rZSBpdCB3aXRoIHRoZVxuICAvLyBgb2JqZWN0YCBhcyBjb250ZXh0OyBvdGhlcndpc2UsIHJldHVybiBpdC5cbiAgXy5yZXN1bHQgPSBmdW5jdGlvbihvYmplY3QsIHByb3BlcnR5KSB7XG4gICAgaWYgKG9iamVjdCA9PSBudWxsKSByZXR1cm4gdm9pZCAwO1xuICAgIHZhciB2YWx1ZSA9IG9iamVjdFtwcm9wZXJ0eV07XG4gICAgcmV0dXJuIF8uaXNGdW5jdGlvbih2YWx1ZSkgPyB2YWx1ZS5jYWxsKG9iamVjdCkgOiB2YWx1ZTtcbiAgfTtcblxuICAvLyBBZGQgeW91ciBvd24gY3VzdG9tIGZ1bmN0aW9ucyB0byB0aGUgVW5kZXJzY29yZSBvYmplY3QuXG4gIF8ubWl4aW4gPSBmdW5jdGlvbihvYmopIHtcbiAgICBlYWNoKF8uZnVuY3Rpb25zKG9iaiksIGZ1bmN0aW9uKG5hbWUpIHtcbiAgICAgIHZhciBmdW5jID0gX1tuYW1lXSA9IG9ialtuYW1lXTtcbiAgICAgIF8ucHJvdG90eXBlW25hbWVdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBhcmdzID0gW3RoaXMuX3dyYXBwZWRdO1xuICAgICAgICBwdXNoLmFwcGx5KGFyZ3MsIGFyZ3VtZW50cyk7XG4gICAgICAgIHJldHVybiByZXN1bHQuY2FsbCh0aGlzLCBmdW5jLmFwcGx5KF8sIGFyZ3MpKTtcbiAgICAgIH07XG4gICAgfSk7XG4gIH07XG5cbiAgLy8gR2VuZXJhdGUgYSB1bmlxdWUgaW50ZWdlciBpZCAodW5pcXVlIHdpdGhpbiB0aGUgZW50aXJlIGNsaWVudCBzZXNzaW9uKS5cbiAgLy8gVXNlZnVsIGZvciB0ZW1wb3JhcnkgRE9NIGlkcy5cbiAgdmFyIGlkQ291bnRlciA9IDA7XG4gIF8udW5pcXVlSWQgPSBmdW5jdGlvbihwcmVmaXgpIHtcbiAgICB2YXIgaWQgPSArK2lkQ291bnRlciArICcnO1xuICAgIHJldHVybiBwcmVmaXggPyBwcmVmaXggKyBpZCA6IGlkO1xuICB9O1xuXG4gIC8vIEJ5IGRlZmF1bHQsIFVuZGVyc2NvcmUgdXNlcyBFUkItc3R5bGUgdGVtcGxhdGUgZGVsaW1pdGVycywgY2hhbmdlIHRoZVxuICAvLyBmb2xsb3dpbmcgdGVtcGxhdGUgc2V0dGluZ3MgdG8gdXNlIGFsdGVybmF0aXZlIGRlbGltaXRlcnMuXG4gIF8udGVtcGxhdGVTZXR0aW5ncyA9IHtcbiAgICBldmFsdWF0ZSAgICA6IC88JShbXFxzXFxTXSs/KSU+L2csXG4gICAgaW50ZXJwb2xhdGUgOiAvPCU9KFtcXHNcXFNdKz8pJT4vZyxcbiAgICBlc2NhcGUgICAgICA6IC88JS0oW1xcc1xcU10rPyklPi9nXG4gIH07XG5cbiAgLy8gV2hlbiBjdXN0b21pemluZyBgdGVtcGxhdGVTZXR0aW5nc2AsIGlmIHlvdSBkb24ndCB3YW50IHRvIGRlZmluZSBhblxuICAvLyBpbnRlcnBvbGF0aW9uLCBldmFsdWF0aW9uIG9yIGVzY2FwaW5nIHJlZ2V4LCB3ZSBuZWVkIG9uZSB0aGF0IGlzXG4gIC8vIGd1YXJhbnRlZWQgbm90IHRvIG1hdGNoLlxuICB2YXIgbm9NYXRjaCA9IC8oLileLztcblxuICAvLyBDZXJ0YWluIGNoYXJhY3RlcnMgbmVlZCB0byBiZSBlc2NhcGVkIHNvIHRoYXQgdGhleSBjYW4gYmUgcHV0IGludG8gYVxuICAvLyBzdHJpbmcgbGl0ZXJhbC5cbiAgdmFyIGVzY2FwZXMgPSB7XG4gICAgXCInXCI6ICAgICAgXCInXCIsXG4gICAgJ1xcXFwnOiAgICAgJ1xcXFwnLFxuICAgICdcXHInOiAgICAgJ3InLFxuICAgICdcXG4nOiAgICAgJ24nLFxuICAgICdcXHQnOiAgICAgJ3QnLFxuICAgICdcXHUyMDI4JzogJ3UyMDI4JyxcbiAgICAnXFx1MjAyOSc6ICd1MjAyOSdcbiAgfTtcblxuICB2YXIgZXNjYXBlciA9IC9cXFxcfCd8XFxyfFxcbnxcXHR8XFx1MjAyOHxcXHUyMDI5L2c7XG5cbiAgLy8gSmF2YVNjcmlwdCBtaWNyby10ZW1wbGF0aW5nLCBzaW1pbGFyIHRvIEpvaG4gUmVzaWcncyBpbXBsZW1lbnRhdGlvbi5cbiAgLy8gVW5kZXJzY29yZSB0ZW1wbGF0aW5nIGhhbmRsZXMgYXJiaXRyYXJ5IGRlbGltaXRlcnMsIHByZXNlcnZlcyB3aGl0ZXNwYWNlLFxuICAvLyBhbmQgY29ycmVjdGx5IGVzY2FwZXMgcXVvdGVzIHdpdGhpbiBpbnRlcnBvbGF0ZWQgY29kZS5cbiAgXy50ZW1wbGF0ZSA9IGZ1bmN0aW9uKHRleHQsIGRhdGEsIHNldHRpbmdzKSB7XG4gICAgdmFyIHJlbmRlcjtcbiAgICBzZXR0aW5ncyA9IF8uZGVmYXVsdHMoe30sIHNldHRpbmdzLCBfLnRlbXBsYXRlU2V0dGluZ3MpO1xuXG4gICAgLy8gQ29tYmluZSBkZWxpbWl0ZXJzIGludG8gb25lIHJlZ3VsYXIgZXhwcmVzc2lvbiB2aWEgYWx0ZXJuYXRpb24uXG4gICAgdmFyIG1hdGNoZXIgPSBuZXcgUmVnRXhwKFtcbiAgICAgIChzZXR0aW5ncy5lc2NhcGUgfHwgbm9NYXRjaCkuc291cmNlLFxuICAgICAgKHNldHRpbmdzLmludGVycG9sYXRlIHx8IG5vTWF0Y2gpLnNvdXJjZSxcbiAgICAgIChzZXR0aW5ncy5ldmFsdWF0ZSB8fCBub01hdGNoKS5zb3VyY2VcbiAgICBdLmpvaW4oJ3wnKSArICd8JCcsICdnJyk7XG5cbiAgICAvLyBDb21waWxlIHRoZSB0ZW1wbGF0ZSBzb3VyY2UsIGVzY2FwaW5nIHN0cmluZyBsaXRlcmFscyBhcHByb3ByaWF0ZWx5LlxuICAgIHZhciBpbmRleCA9IDA7XG4gICAgdmFyIHNvdXJjZSA9IFwiX19wKz0nXCI7XG4gICAgdGV4dC5yZXBsYWNlKG1hdGNoZXIsIGZ1bmN0aW9uKG1hdGNoLCBlc2NhcGUsIGludGVycG9sYXRlLCBldmFsdWF0ZSwgb2Zmc2V0KSB7XG4gICAgICBzb3VyY2UgKz0gdGV4dC5zbGljZShpbmRleCwgb2Zmc2V0KVxuICAgICAgICAucmVwbGFjZShlc2NhcGVyLCBmdW5jdGlvbihtYXRjaCkgeyByZXR1cm4gJ1xcXFwnICsgZXNjYXBlc1ttYXRjaF07IH0pO1xuXG4gICAgICBpZiAoZXNjYXBlKSB7XG4gICAgICAgIHNvdXJjZSArPSBcIicrXFxuKChfX3Q9KFwiICsgZXNjYXBlICsgXCIpKT09bnVsbD8nJzpfLmVzY2FwZShfX3QpKStcXG4nXCI7XG4gICAgICB9XG4gICAgICBpZiAoaW50ZXJwb2xhdGUpIHtcbiAgICAgICAgc291cmNlICs9IFwiJytcXG4oKF9fdD0oXCIgKyBpbnRlcnBvbGF0ZSArIFwiKSk9PW51bGw/Jyc6X190KStcXG4nXCI7XG4gICAgICB9XG4gICAgICBpZiAoZXZhbHVhdGUpIHtcbiAgICAgICAgc291cmNlICs9IFwiJztcXG5cIiArIGV2YWx1YXRlICsgXCJcXG5fX3ArPSdcIjtcbiAgICAgIH1cbiAgICAgIGluZGV4ID0gb2Zmc2V0ICsgbWF0Y2gubGVuZ3RoO1xuICAgICAgcmV0dXJuIG1hdGNoO1xuICAgIH0pO1xuICAgIHNvdXJjZSArPSBcIic7XFxuXCI7XG5cbiAgICAvLyBJZiBhIHZhcmlhYmxlIGlzIG5vdCBzcGVjaWZpZWQsIHBsYWNlIGRhdGEgdmFsdWVzIGluIGxvY2FsIHNjb3BlLlxuICAgIGlmICghc2V0dGluZ3MudmFyaWFibGUpIHNvdXJjZSA9ICd3aXRoKG9ianx8e30pe1xcbicgKyBzb3VyY2UgKyAnfVxcbic7XG5cbiAgICBzb3VyY2UgPSBcInZhciBfX3QsX19wPScnLF9faj1BcnJheS5wcm90b3R5cGUuam9pbixcIiArXG4gICAgICBcInByaW50PWZ1bmN0aW9uKCl7X19wKz1fX2ouY2FsbChhcmd1bWVudHMsJycpO307XFxuXCIgK1xuICAgICAgc291cmNlICsgXCJyZXR1cm4gX19wO1xcblwiO1xuXG4gICAgdHJ5IHtcbiAgICAgIHJlbmRlciA9IG5ldyBGdW5jdGlvbihzZXR0aW5ncy52YXJpYWJsZSB8fCAnb2JqJywgJ18nLCBzb3VyY2UpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGUuc291cmNlID0gc291cmNlO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG5cbiAgICBpZiAoZGF0YSkgcmV0dXJuIHJlbmRlcihkYXRhLCBfKTtcbiAgICB2YXIgdGVtcGxhdGUgPSBmdW5jdGlvbihkYXRhKSB7XG4gICAgICByZXR1cm4gcmVuZGVyLmNhbGwodGhpcywgZGF0YSwgXyk7XG4gICAgfTtcblxuICAgIC8vIFByb3ZpZGUgdGhlIGNvbXBpbGVkIGZ1bmN0aW9uIHNvdXJjZSBhcyBhIGNvbnZlbmllbmNlIGZvciBwcmVjb21waWxhdGlvbi5cbiAgICB0ZW1wbGF0ZS5zb3VyY2UgPSAnZnVuY3Rpb24oJyArIChzZXR0aW5ncy52YXJpYWJsZSB8fCAnb2JqJykgKyAnKXtcXG4nICsgc291cmNlICsgJ30nO1xuXG4gICAgcmV0dXJuIHRlbXBsYXRlO1xuICB9O1xuXG4gIC8vIEFkZCBhIFwiY2hhaW5cIiBmdW5jdGlvbiwgd2hpY2ggd2lsbCBkZWxlZ2F0ZSB0byB0aGUgd3JhcHBlci5cbiAgXy5jaGFpbiA9IGZ1bmN0aW9uKG9iaikge1xuICAgIHJldHVybiBfKG9iaikuY2hhaW4oKTtcbiAgfTtcblxuICAvLyBPT1BcbiAgLy8gLS0tLS0tLS0tLS0tLS0tXG4gIC8vIElmIFVuZGVyc2NvcmUgaXMgY2FsbGVkIGFzIGEgZnVuY3Rpb24sIGl0IHJldHVybnMgYSB3cmFwcGVkIG9iamVjdCB0aGF0XG4gIC8vIGNhbiBiZSB1c2VkIE9PLXN0eWxlLiBUaGlzIHdyYXBwZXIgaG9sZHMgYWx0ZXJlZCB2ZXJzaW9ucyBvZiBhbGwgdGhlXG4gIC8vIHVuZGVyc2NvcmUgZnVuY3Rpb25zLiBXcmFwcGVkIG9iamVjdHMgbWF5IGJlIGNoYWluZWQuXG5cbiAgLy8gSGVscGVyIGZ1bmN0aW9uIHRvIGNvbnRpbnVlIGNoYWluaW5nIGludGVybWVkaWF0ZSByZXN1bHRzLlxuICB2YXIgcmVzdWx0ID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgcmV0dXJuIHRoaXMuX2NoYWluID8gXyhvYmopLmNoYWluKCkgOiBvYmo7XG4gIH07XG5cbiAgLy8gQWRkIGFsbCBvZiB0aGUgVW5kZXJzY29yZSBmdW5jdGlvbnMgdG8gdGhlIHdyYXBwZXIgb2JqZWN0LlxuICBfLm1peGluKF8pO1xuXG4gIC8vIEFkZCBhbGwgbXV0YXRvciBBcnJheSBmdW5jdGlvbnMgdG8gdGhlIHdyYXBwZXIuXG4gIGVhY2goWydwb3AnLCAncHVzaCcsICdyZXZlcnNlJywgJ3NoaWZ0JywgJ3NvcnQnLCAnc3BsaWNlJywgJ3Vuc2hpZnQnXSwgZnVuY3Rpb24obmFtZSkge1xuICAgIHZhciBtZXRob2QgPSBBcnJheVByb3RvW25hbWVdO1xuICAgIF8ucHJvdG90eXBlW25hbWVdID0gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgb2JqID0gdGhpcy5fd3JhcHBlZDtcbiAgICAgIG1ldGhvZC5hcHBseShvYmosIGFyZ3VtZW50cyk7XG4gICAgICBpZiAoKG5hbWUgPT0gJ3NoaWZ0JyB8fCBuYW1lID09ICdzcGxpY2UnKSAmJiBvYmoubGVuZ3RoID09PSAwKSBkZWxldGUgb2JqWzBdO1xuICAgICAgcmV0dXJuIHJlc3VsdC5jYWxsKHRoaXMsIG9iaik7XG4gICAgfTtcbiAgfSk7XG5cbiAgLy8gQWRkIGFsbCBhY2Nlc3NvciBBcnJheSBmdW5jdGlvbnMgdG8gdGhlIHdyYXBwZXIuXG4gIGVhY2goWydjb25jYXQnLCAnam9pbicsICdzbGljZSddLCBmdW5jdGlvbihuYW1lKSB7XG4gICAgdmFyIG1ldGhvZCA9IEFycmF5UHJvdG9bbmFtZV07XG4gICAgXy5wcm90b3R5cGVbbmFtZV0gPSBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiByZXN1bHQuY2FsbCh0aGlzLCBtZXRob2QuYXBwbHkodGhpcy5fd3JhcHBlZCwgYXJndW1lbnRzKSk7XG4gICAgfTtcbiAgfSk7XG5cbiAgXy5leHRlbmQoXy5wcm90b3R5cGUsIHtcblxuICAgIC8vIFN0YXJ0IGNoYWluaW5nIGEgd3JhcHBlZCBVbmRlcnNjb3JlIG9iamVjdC5cbiAgICBjaGFpbjogZnVuY3Rpb24oKSB7XG4gICAgICB0aGlzLl9jaGFpbiA9IHRydWU7XG4gICAgICByZXR1cm4gdGhpcztcbiAgICB9LFxuXG4gICAgLy8gRXh0cmFjdHMgdGhlIHJlc3VsdCBmcm9tIGEgd3JhcHBlZCBhbmQgY2hhaW5lZCBvYmplY3QuXG4gICAgdmFsdWU6IGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIHRoaXMuX3dyYXBwZWQ7XG4gICAgfVxuXG4gIH0pO1xuXG59KS5jYWxsKHRoaXMpO1xuIiwiLy8gY3JlYXRlZCBieSBASGVucmlrSm9yZXRlZ1xudmFyIHByZWZpeDtcbnZhciBpc0Nocm9tZSA9IGZhbHNlO1xudmFyIGlzRmlyZWZveCA9IGZhbHNlO1xudmFyIHVhID0gbmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpO1xuXG4vLyBiYXNpYyBzbmlmZmluZ1xuaWYgKHVhLmluZGV4T2YoJ2ZpcmVmb3gnKSAhPT0gLTEpIHtcbiAgICBwcmVmaXggPSAnbW96JztcbiAgICBpc0ZpcmVmb3ggPSB0cnVlO1xufSBlbHNlIGlmICh1YS5pbmRleE9mKCdjaHJvbWUnKSAhPT0gLTEpIHtcbiAgICBwcmVmaXggPSAnd2Via2l0JztcbiAgICBpc0Nocm9tZSA9IHRydWU7XG59XG5cbnZhciBQQyA9IHdpbmRvdy5tb3pSVENQZWVyQ29ubmVjdGlvbiB8fCB3aW5kb3cud2Via2l0UlRDUGVlckNvbm5lY3Rpb247XG52YXIgSWNlQ2FuZGlkYXRlID0gd2luZG93Lm1velJUQ0ljZUNhbmRpZGF0ZSB8fCB3aW5kb3cuUlRDSWNlQ2FuZGlkYXRlO1xudmFyIFNlc3Npb25EZXNjcmlwdGlvbiA9IHdpbmRvdy5tb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gfHwgd2luZG93LlJUQ1Nlc3Npb25EZXNjcmlwdGlvbjtcbnZhciBNZWRpYVN0cmVhbSA9IHdpbmRvdy53ZWJraXRNZWRpYVN0cmVhbSB8fCB3aW5kb3cuTWVkaWFTdHJlYW07XG52YXIgc2NyZWVuU2hhcmluZyA9IG5hdmlnYXRvci51c2VyQWdlbnQubWF0Y2goJ0Nocm9tZScpICYmIHBhcnNlSW50KG5hdmlnYXRvci51c2VyQWdlbnQubWF0Y2goL0Nocm9tZVxcLyguKikgLylbMV0sIDEwKSA+PSAyNjtcbnZhciBBdWRpb0NvbnRleHQgPSB3aW5kb3cud2Via2l0QXVkaW9Db250ZXh0IHx8IHdpbmRvdy5BdWRpb0NvbnRleHQ7XG5cblxuLy8gZXhwb3J0IHN1cHBvcnQgZmxhZ3MgYW5kIGNvbnN0cnVjdG9ycy5wcm90b3R5cGUgJiYgUENcbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIHN1cHBvcnQ6ICEhUEMsXG4gICAgZGF0YUNoYW5uZWw6IGlzQ2hyb21lIHx8IGlzRmlyZWZveCB8fCAoUEMucHJvdG90eXBlICYmIFBDLnByb3RvdHlwZS5jcmVhdGVEYXRhQ2hhbm5lbCksXG4gICAgcHJlZml4OiBwcmVmaXgsXG4gICAgd2ViQXVkaW86ICEhKEF1ZGlvQ29udGV4dCAmJiBBdWRpb0NvbnRleHQucHJvdG90eXBlLmNyZWF0ZU1lZGlhU3RyZWFtU291cmNlKSxcbiAgICBtZWRpYVN0cmVhbTogISEoTWVkaWFTdHJlYW0gJiYgTWVkaWFTdHJlYW0ucHJvdG90eXBlLnJlbW92ZVRyYWNrKSxcbiAgICBzY3JlZW5TaGFyaW5nOiAhIXNjcmVlblNoYXJpbmcsXG4gICAgQXVkaW9Db250ZXh0OiBBdWRpb0NvbnRleHQsXG4gICAgUGVlckNvbm5lY3Rpb246IFBDLFxuICAgIFNlc3Npb25EZXNjcmlwdGlvbjogU2Vzc2lvbkRlc2NyaXB0aW9uLFxuICAgIEljZUNhbmRpZGF0ZTogSWNlQ2FuZGlkYXRlXG59O1xuIiwiLypcbldpbGRFbWl0dGVyLmpzIGlzIGEgc2xpbSBsaXR0bGUgZXZlbnQgZW1pdHRlciBieSBAaGVucmlram9yZXRlZyBsYXJnZWx5IGJhc2VkIFxub24gQHZpc2lvbm1lZGlhJ3MgRW1pdHRlciBmcm9tIFVJIEtpdC5cblxuV2h5PyBJIHdhbnRlZCBpdCBzdGFuZGFsb25lLlxuXG5JIGFsc28gd2FudGVkIHN1cHBvcnQgZm9yIHdpbGRjYXJkIGVtaXR0ZXJzIGxpa2UgdGhpczpcblxuZW1pdHRlci5vbignKicsIGZ1bmN0aW9uIChldmVudE5hbWUsIG90aGVyLCBldmVudCwgcGF5bG9hZHMpIHtcbiAgICBcbn0pO1xuXG5lbWl0dGVyLm9uKCdzb21lbmFtZXNwYWNlKicsIGZ1bmN0aW9uIChldmVudE5hbWUsIHBheWxvYWRzKSB7XG4gICAgXG59KTtcblxuUGxlYXNlIG5vdGUgdGhhdCBjYWxsYmFja3MgdHJpZ2dlcmVkIGJ5IHdpbGRjYXJkIHJlZ2lzdGVyZWQgZXZlbnRzIGFsc28gZ2V0IFxudGhlIGV2ZW50IG5hbWUgYXMgdGhlIGZpcnN0IGFyZ3VtZW50LlxuKi9cbm1vZHVsZS5leHBvcnRzID0gV2lsZEVtaXR0ZXI7XG5cbmZ1bmN0aW9uIFdpbGRFbWl0dGVyKCkge1xuICAgIHRoaXMuY2FsbGJhY2tzID0ge307XG59XG5cbi8vIExpc3RlbiBvbiB0aGUgZ2l2ZW4gYGV2ZW50YCB3aXRoIGBmbmAuIFN0b3JlIGEgZ3JvdXAgbmFtZSBpZiBwcmVzZW50LlxuV2lsZEVtaXR0ZXIucHJvdG90eXBlLm9uID0gZnVuY3Rpb24gKGV2ZW50LCBncm91cE5hbWUsIGZuKSB7XG4gICAgdmFyIGhhc0dyb3VwID0gKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpLFxuICAgICAgICBncm91cCA9IGhhc0dyb3VwID8gYXJndW1lbnRzWzFdIDogdW5kZWZpbmVkLCBcbiAgICAgICAgZnVuYyA9IGhhc0dyb3VwID8gYXJndW1lbnRzWzJdIDogYXJndW1lbnRzWzFdO1xuICAgIGZ1bmMuX2dyb3VwTmFtZSA9IGdyb3VwO1xuICAgICh0aGlzLmNhbGxiYWNrc1tldmVudF0gPSB0aGlzLmNhbGxiYWNrc1tldmVudF0gfHwgW10pLnB1c2goZnVuYyk7XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG4vLyBBZGRzIGFuIGBldmVudGAgbGlzdGVuZXIgdGhhdCB3aWxsIGJlIGludm9rZWQgYSBzaW5nbGVcbi8vIHRpbWUgdGhlbiBhdXRvbWF0aWNhbGx5IHJlbW92ZWQuXG5XaWxkRW1pdHRlci5wcm90b3R5cGUub25jZSA9IGZ1bmN0aW9uIChldmVudCwgZ3JvdXBOYW1lLCBmbikge1xuICAgIHZhciBzZWxmID0gdGhpcyxcbiAgICAgICAgaGFzR3JvdXAgPSAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMyksXG4gICAgICAgIGdyb3VwID0gaGFzR3JvdXAgPyBhcmd1bWVudHNbMV0gOiB1bmRlZmluZWQsIFxuICAgICAgICBmdW5jID0gaGFzR3JvdXAgPyBhcmd1bWVudHNbMl0gOiBhcmd1bWVudHNbMV07XG4gICAgZnVuY3Rpb24gb24oKSB7XG4gICAgICAgIHNlbGYub2ZmKGV2ZW50LCBvbik7XG4gICAgICAgIGZ1bmMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG4gICAgdGhpcy5vbihldmVudCwgZ3JvdXAsIG9uKTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cbi8vIFVuYmluZHMgYW4gZW50aXJlIGdyb3VwXG5XaWxkRW1pdHRlci5wcm90b3R5cGUucmVsZWFzZUdyb3VwID0gZnVuY3Rpb24gKGdyb3VwTmFtZSkge1xuICAgIHZhciBpdGVtLCBpLCBsZW4sIGhhbmRsZXJzO1xuICAgIGZvciAoaXRlbSBpbiB0aGlzLmNhbGxiYWNrcykge1xuICAgICAgICBoYW5kbGVycyA9IHRoaXMuY2FsbGJhY2tzW2l0ZW1dO1xuICAgICAgICBmb3IgKGkgPSAwLCBsZW4gPSBoYW5kbGVycy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgICAgICAgICAgaWYgKGhhbmRsZXJzW2ldLl9ncm91cE5hbWUgPT09IGdyb3VwTmFtZSkge1xuICAgICAgICAgICAgICAgIC8vY29uc29sZS5sb2coJ3JlbW92aW5nJyk7XG4gICAgICAgICAgICAgICAgLy8gcmVtb3ZlIGl0IGFuZCBzaG9ydGVuIHRoZSBhcnJheSB3ZSdyZSBsb29waW5nIHRocm91Z2hcbiAgICAgICAgICAgICAgICBoYW5kbGVycy5zcGxpY2UoaSwgMSk7XG4gICAgICAgICAgICAgICAgaS0tO1xuICAgICAgICAgICAgICAgIGxlbi0tO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xufTtcblxuLy8gUmVtb3ZlIHRoZSBnaXZlbiBjYWxsYmFjayBmb3IgYGV2ZW50YCBvciBhbGxcbi8vIHJlZ2lzdGVyZWQgY2FsbGJhY2tzLlxuV2lsZEVtaXR0ZXIucHJvdG90eXBlLm9mZiA9IGZ1bmN0aW9uIChldmVudCwgZm4pIHtcbiAgICB2YXIgY2FsbGJhY2tzID0gdGhpcy5jYWxsYmFja3NbZXZlbnRdLFxuICAgICAgICBpO1xuICAgIFxuICAgIGlmICghY2FsbGJhY2tzKSByZXR1cm4gdGhpcztcblxuICAgIC8vIHJlbW92ZSBhbGwgaGFuZGxlcnNcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBkZWxldGUgdGhpcy5jYWxsYmFja3NbZXZlbnRdO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICAvLyByZW1vdmUgc3BlY2lmaWMgaGFuZGxlclxuICAgIGkgPSBjYWxsYmFja3MuaW5kZXhPZihmbik7XG4gICAgY2FsbGJhY2tzLnNwbGljZShpLCAxKTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cbi8vIEVtaXQgYGV2ZW50YCB3aXRoIHRoZSBnaXZlbiBhcmdzLlxuLy8gYWxzbyBjYWxscyBhbnkgYCpgIGhhbmRsZXJzXG5XaWxkRW1pdHRlci5wcm90b3R5cGUuZW1pdCA9IGZ1bmN0aW9uIChldmVudCkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpLFxuICAgICAgICBjYWxsYmFja3MgPSB0aGlzLmNhbGxiYWNrc1tldmVudF0sXG4gICAgICAgIHNwZWNpYWxDYWxsYmFja3MgPSB0aGlzLmdldFdpbGRjYXJkQ2FsbGJhY2tzKGV2ZW50KSxcbiAgICAgICAgaSxcbiAgICAgICAgbGVuLFxuICAgICAgICBpdGVtO1xuXG4gICAgaWYgKGNhbGxiYWNrcykge1xuICAgICAgICBmb3IgKGkgPSAwLCBsZW4gPSBjYWxsYmFja3MubGVuZ3RoOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgICAgIGlmIChjYWxsYmFja3NbaV0pIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFja3NbaV0uYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNwZWNpYWxDYWxsYmFja3MpIHtcbiAgICAgICAgZm9yIChpID0gMCwgbGVuID0gc3BlY2lhbENhbGxiYWNrcy5sZW5ndGg7IGkgPCBsZW47ICsraSkge1xuICAgICAgICAgICAgaWYgKHNwZWNpYWxDYWxsYmFja3NbaV0pIHtcbiAgICAgICAgICAgICAgICBzcGVjaWFsQ2FsbGJhY2tzW2ldLmFwcGx5KHRoaXMsIFtldmVudF0uY29uY2F0KGFyZ3MpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcztcbn07XG5cbi8vIEhlbHBlciBmb3IgZm9yIGZpbmRpbmcgc3BlY2lhbCB3aWxkY2FyZCBldmVudCBoYW5kbGVycyB0aGF0IG1hdGNoIHRoZSBldmVudFxuV2lsZEVtaXR0ZXIucHJvdG90eXBlLmdldFdpbGRjYXJkQ2FsbGJhY2tzID0gZnVuY3Rpb24gKGV2ZW50TmFtZSkge1xuICAgIHZhciBpdGVtLFxuICAgICAgICBzcGxpdCxcbiAgICAgICAgcmVzdWx0ID0gW107XG5cbiAgICBmb3IgKGl0ZW0gaW4gdGhpcy5jYWxsYmFja3MpIHtcbiAgICAgICAgc3BsaXQgPSBpdGVtLnNwbGl0KCcqJyk7XG4gICAgICAgIGlmIChpdGVtID09PSAnKicgfHwgKHNwbGl0Lmxlbmd0aCA9PT0gMiAmJiBldmVudE5hbWUuc2xpY2UoMCwgc3BsaXRbMV0ubGVuZ3RoKSA9PT0gc3BsaXRbMV0pKSB7XG4gICAgICAgICAgICByZXN1bHQgPSByZXN1bHQuY29uY2F0KHRoaXMuY2FsbGJhY2tzW2l0ZW1dKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xufTtcbiJdfQ==
;