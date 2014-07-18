!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.XMPP=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
(function (process){
'use strict';

exports.lang = process.env.LANG;

exports.Stream = _dereq_('./lib/stanza/stream');
exports.BOSH = _dereq_('./lib/stanza/bosh');
exports.Message = _dereq_('./lib/stanza/message');
exports.Presence = _dereq_('./lib/stanza/presence');
exports.Iq = _dereq_('./lib/stanza/iq');

exports.PubsubEvent = _dereq_('./lib/stanza/pubsubEvents').EventItem;
exports.PubsubItem = _dereq_('./lib/stanza/pubsub').Item;

exports.JID = _dereq_('xmpp-jid').JID;

exports.Client = _dereq_('./lib/client');
exports.crypto = _dereq_('crypto');
exports.jxt = _dereq_('jxt');

exports.jingle = _dereq_('./lib/stanza/jingle');


exports.createClient = function (opts) {
    var client = new exports.Client(opts);
    client.use(_dereq_('./lib/plugins'));

    return client;
};

}).call(this,_dereq_("FWaASH"))
},{"./lib/client":2,"./lib/plugins":21,"./lib/stanza/bosh":51,"./lib/stanza/iq":66,"./lib/stanza/jingle":67,"./lib/stanza/message":71,"./lib/stanza/presence":77,"./lib/stanza/pubsub":80,"./lib/stanza/pubsubEvents":82,"./lib/stanza/stream":94,"FWaASH":166,"crypto":154,"jxt":204,"xmpp-jid":225}],2:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var WildEmitter = _dereq_('wildemitter');
var util = _dereq_('util');
var Promise = _dereq_('bluebird');
var async = _dereq_('async');
var uuid = _dereq_('node-uuid');
var b64decode = _dereq_('atob');
var b64encode = _dereq_('btoa');
var SASL = _dereq_('./stanza/sasl');
var Message = _dereq_('./stanza/message');
var Presence = _dereq_('./stanza/presence');
var StreamError = _dereq_('./stanza/streamError');
var Iq = _dereq_('./stanza/iq');
var JID = _dereq_('xmpp-jid').JID;
var StreamManagement = _dereq_('./sm');
var WSConnection = _dereq_('./transports/websocket');
var OldWSConnection = _dereq_('./transports/old-websocket');
var BOSHConnection = _dereq_('./transports/bosh');
var getHostMeta = _dereq_('hostmeta');
var SASLFactory = _dereq_('saslmechanisms');


var SASL_MECHS = {
    external: _dereq_('sasl-external'),
    'scram-sha-1': _dereq_('sasl-scram-sha-1'),
    'digest-md5': _dereq_('alt-sasl-digest-md5'),
    plain: _dereq_('sasl-plain'),
    anonymous: _dereq_('sasl-anonymous')
};


// Ensure that all basic stanza relationships are established
_dereq_('./stanza/stream');
_dereq_('./stanza/sm');
_dereq_('./stanza/error');
_dereq_('./stanza/streamFeatures');
_dereq_('./stanza/bind');
_dereq_('./stanza/session');


function Client(opts) {
    var self = this;

    WildEmitter.call(this);

    opts = opts || {};
    this._initConfig(opts);

    this.jid = new JID();

    this.transports = {
        websocket: WSConnection,
        bosh: BOSHConnection,
        'old-websocket': OldWSConnection
    };

    this.negotiatedFeatures = {};
    this.featureOrder = [
        'sasl',
        'streamManagement',
        'bind',
        'streamManagement',
        'caps',
        'session'
    ];
    this.features = {};

    this.sm = new StreamManagement(this);

    this.on('stream:data', function (data) {
        var json = data.toJSON();

        if (data._name === 'iq') {
            json._xmlChildCount = 0;
            _.each(data.xml.childNodes, function (child) {
                if (child.nodeType === 1) {
                    json._xmlChildCount += 1;
                }
            });
        }

        self.emit(data._eventname || data._name, json);
        if (data._name === 'message' || data._name === 'presence' || data._name === 'iq') {
            self.sm.handle(json);
            self.emit('stanza', json);
        } else if (data._name === 'smAck') {
            return self.sm.process(json);
        } else if (data._name === 'smRequest') {
            return self.sm.ack();
        }

        if (json.id) {
            self.emit('id:' + json.id, json);
        }
    });

    this.on('streamFeatures', function (features) {
        var series = [];

        self.featureOrder.forEach(function (name) {
            if (features[name] && !self.negotiatedFeatures[name]) {
                series.push(function (cb) {
                    if (!self.negotiatedFeatures[name] && self.features[name]) {
                        self.features[name](features, cb);
                    } else {
                        cb();
                    }
                });
            }
        });

        async.series(series, function (cmd, msg) {
            if (cmd === 'restart') {
                self.transport.restart();
            } else if (cmd === 'disconnect') {
                var serr = new StreamError({
                    condition: 'policy-violation',
                    text: 'failed to negotiate stream features: ' + msg
                });
                self.emit('stream:error', serr);
                self.disconnect();
            }
        });
    });

    this.features.sasl = function (features, cb) {
        var mech = self.SASLFactory.create(features.sasl.mechanisms);
        if (!mech) {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            return cb('disconnect', 'authentication failed');
        }

        self.on('sasl:success', 'sasl', function () {
            self.negotiatedFeatures.sasl = true;
            self.releaseGroup('sasl');
            self.emit('auth:success', self.config.credentials);
            cb('restart');
        });
        self.on('sasl:challenge', 'sasl', function (challenge) {
            mech.challenge(challenge.value);
            self.send(new SASL.Response({
                value: mech.response(self.getCredentials())
            }));

            if (mech.cache) {
                _.each(mech.cache, function (val, key) {
                    if (val) {
                        self.config.credentials[key] = b64encode(val);
                    }
                });
                self.emit('credentials:update', self.config.credentials);
            }

            cb();
        });
        self.on('sasl:failure', 'sasl', function () {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            cb('disconnect', 'authentication failed');
        });
        self.on('sasl:abort', 'sasl', function () {
            self.releaseGroup('sasl');
            self.emit('auth:failed');
            cb('disconnect', 'authentication failed');
        });

        var auth = {
            mechanism: mech.name
        };

        if (mech.clientFirst) {
            auth.value = mech.response(self.getCredentials());
        }
        self.send(new SASL.Auth(auth));
    };

    this.features.bind = function (features, cb) {
        self.sendIq({
            type: 'set',
            bind: {
                resource: self.config.resource
            }
        }, function (err, resp) {
            if (err) {
                self.emit('session:error', err);
                return cb('disconnect', 'JID binding failed');
            }

            self.negotiatedFeatures.bind = true;
            self.emit('session:bound', resp.bind.jid);
            self.jid = new JID(resp.bind.jid);
            var canStartSession = !features.session || (features.session && features.session.optional);
            if (!self.sessionStarted && canStartSession) {
                self.sessionStarted = true;
                self.emit('session:started', resp.bind.jid);
            }
            cb();
        });
    };

    this.features.session = function (features, cb) {
        if (features.session.optional || self.sessionStarted) {
            self.negotiatedFeatures.session = true;
            return cb();
        }

        self.sendIq({
            type: 'set',
            session: {}
        }, function (err) {
            if (err) {
                return cb('disconnect', 'session request failed');
            }

            self.negotiatedFeatures.session = true;
            if (!self.sessionStarted) {
                self.sessionStarted = true;
                self.emit('session:started', self.jid);
            }
            cb();
        });
    };

    this.features.caps = function (features, cb) {
        self.emit('disco:caps', {from: new JID(self.jid.domain), caps: features.caps});
        self.negotiatedFeatures.caps = true;
        cb();
    };

    this.features.streamManagement = function (features, cb) {
        if (!self.config.useStreamManagement) {
            return cb();
        }

        self.on('stream:management:enabled', 'sm', function (enabled) {
            self.sm.enabled(enabled);
            self.negotiatedFeatures.streamManagement = true;
            self.releaseGroup('sm');
            cb();
        });

        self.on('stream:management:resumed', 'sm', function (resumed) {
            self.sm.resumed(resumed);
            self.negotiatedFeatures.streamManagement = true;
            self.negotiatedFeatures.bind = true;
            self.sessionStarted = true;
            self.releaseGroup('sm');
            cb('break'); // Halt further processing of stream features
        });

        self.on('stream:management:failed', 'sm', function () {
            self.sm.failed();
            self.emit('session:end');
            self.releaseGroup('session');
            self.releaseGroup('sm');
            cb();
        });

        if (!self.sm.id) {
            if (self.negotiatedFeatures.bind) {
                self.sm.enable();
            } else {
                cb();
            }
        } else if (self.sm.id && self.sm.allowResume) {
            self.sm.resume();
        } else {
            cb();
        }
    };

    this.on('disconnected', function () {
        if (self.transport) {
            self.transport.off('*');
            delete self.transport;
        }
        self.sessionStarted = false;
        self.negotiatedFeatures.sasl = false;
        self.negotiatedFeatures.streamManagement = false;
        self.negotiatedFeatures.bind = false;
        self.negotiatedFeatures.session = false;
        self.releaseGroup('connection');
    });

    this.on('iq', function (iq) {
        var iqType = iq.type;
        var xmlChildCount = iq._xmlChildCount;
        delete iq._xmlChildCount;

        var exts = Object.keys(iq);

        if (iq.type === 'get' || iq.type === 'set') {
            // Invalid request
            if (xmlChildCount !== 1) {
                return self.sendIq(iq.errorReply({
                    error: {
                        type: 'modify',
                        condition: 'bad-request'
                    }
                }));
            }

            // Valid request, but we don't have support for the
            // payload data.
            if (!exts.length) {
                return self.sendIq(iq.errorReply({
                    error: {
                        type: 'cancel',
                        condition: 'feature-not-implemented'
                    }
                }));
            }

            var iqEvent = 'iq:' + iqType + ':' + exts[0];
            if (self.callbacks[iqEvent]) {
                self.emit(iqEvent, iq);
            } else {
                // We support the payload data, but there's
                // nothing registered to handle it.
                self.sendIq(iq.errorReply({
                    error: {
                        type: 'cancel',
                        condition: 'feature-not-implemented'
                    }
                }));
            }
        }
    });

    this.on('message', function (msg) {
        if (Object.keys(msg.$body || {}).length) {
            if (msg.type === 'chat' || msg.type === 'normal') {
                self.emit('chat', msg);
            } else if (msg.type === 'groupchat') {
                self.emit('groupchat', msg);
            }
        }
        if (msg.type === 'error') {
            self.emit('message:error', msg);
        }
    });

    this.on('presence', function (pres) {
        var presType = pres.type || 'available';
        if (presType === 'error') {
            presType = 'presence:error';
        }
        self.emit(presType, pres);
    });
}

util.inherits(Client, WildEmitter);

Object.defineProperty(Client.prototype, 'stream', {
    get: function () {
        return this.transport ? this.transport.stream : undefined;
    }
});

Client.prototype._initConfig = function (opts) {
    var self = this;
    var currConfig = this.config || {};

    this.config = _.extend({
        useStreamManagement: true,
        transports: ['websocket', 'bosh'],
        sasl: ['external', 'scram-sha-1', 'digest-md5', 'plain', 'anonymous']
    }, currConfig, opts);

    // Enable SASL authentication mechanisms (and their preferred order)
    // based on user configuration.
    if (!_.isArray(this.config.sasl)) {
        this.config.sasl = [this.config.sasl];
    }

    this.SASLFactory = new SASLFactory();
    this.config.sasl.forEach(function (mech) {
        if (typeof mech === 'string') {
            var existingMech = SASL_MECHS[mech.toLowerCase()];
            if (existingMech) {
                self.SASLFactory.use(existingMech);
            }
        } else {
            self.SASLFactory.use(mech);
        }
    });

    this.config.jid = new JID(this.config.jid);

    if (!this.config.server) {
        this.config.server = this.config.jid.domain;
    }

    if (this.config.password) {
        this.config.credentials = this.config.credentials || {};
        this.config.credentials.password = this.config.password;
        delete this.config.password;
    }

    if (this.config.transport) {
        this.config.transports = [this.config.transport];
    }

    if (!_.isArray(this.config.transports)) {
        this.config.transports = [this.config.transports];
    }
};

Client.prototype.use = function (pluginInit) {
    pluginInit(this);
};

Client.prototype.nextId = function () {
    return uuid.v4();
};

Client.prototype.discoverBindings = function (server, cb) {
    getHostMeta(server, function (err, data) {
        if (err) {
            return cb(err, []);
        }

        var results = {
            websocket: [],
            bosh: []
        };
        var links = data.links || [];

        links.forEach(function (link) {
            if (link.href && link.rel === 'urn:xmpp:alt-connections:websocket') {
                results.websocket.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:altconnect:websocket') {
                results.websocket.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:alt-connections:xbosh') {
                results.bosh.push(link.href);
            }
            if (link.href && link.rel === 'urn:xmpp:altconnect:bosh') {
                results.bosh.push(link.href);
            }
        });

        cb(false, results);
    });
};

Client.prototype.getCredentials = function () {
    var creds = this.config.credentials || {};
    var requestedJID = new JID(this.config.jid);

    var username = creds.username || requestedJID.local;
    var server = creds.server || requestedJID.domain;

    var defaultCreds = {
        username: username,
        password: this.config.password,
        server: server,
        host: server,
        realm: server,
        serviceType: 'xmpp',
        serviceName: server
    };

    var result = _.extend(defaultCreds, creds);

    var cachedBinary = ['saltedPassword', 'clientKey', 'serverKey'];
    cachedBinary.forEach(function (key) {
        if (result[key]) {
            result[key] = b64decode(result[key]);
        }
    });

    return result;
};

Client.prototype.connect = function (opts, transInfo) {
    var self = this;

    this._initConfig(opts);

    if (transInfo && transInfo.name && transInfo.url) {
        var trans = self.transport = new self.transports[transInfo.name](self.sm);
        trans.on('*', function (event, data) {
            self.emit(event, data);
        });
        return trans.connect(self.config);
    }

    if (!transInfo && self.config.transports.length === 1) {
        transInfo = {};
        transInfo.name = self.config.transports[0];
        if (transInfo.name === 'websocket' || transInfo.name === 'old-websocket') {
            transInfo.url = self.config.wsURL;
        }
        if (transInfo.name === 'bosh') {
            transInfo.url = self.config.boshURL;
        }
        if (transInfo.name && transInfo.url) {
            return self.connect(null, transInfo);
        }
    }

    return self.discoverBindings(self.config.server, function (err, endpoints) {
        if (err) {
            return self.disconnect();
        }

        for (var t = 0, tlen = self.config.transports.length; t < tlen; t++) {
            var transport = self.config.transports[t];
            console.log('Checking for %s endpoints', transport);
            for (var i = 0, len = (endpoints[transport] || []).length; i < len; i++) {
                var uri = endpoints[transport][i];
                if (uri.indexOf('wss://') === 0 || uri.indexOf('https://') === 0) {
                    if (transport === 'websocket') {
                        self.config.wsURL = uri;
                    } else {
                        self.config.boshURL = uri;
                    }
                    console.log('Using %s endpoint: %s', transport, uri);
                    return self.connect(null, {
                        name: transport,
                        url: uri
                    });
                } else {
                    console.warn('Discovered unencrypted %s endpoint (%s). Ignoring', transport, uri);
                }
            }
        }
        console.warn('No endpoints found for the requested transports.');
        return self.disconnect();
    });
};

Client.prototype.disconnect = function () {
    if (this.sessionStarted) {
        this.releaseGroup('session');
        if (!this.sm.started) {
            // Only emit session:end if we had a session, and we aren't using
            // stream management to keep the session alive.
            this.emit('session:end');
        }
    }
    this.sessionStarted = false;
    this.releaseGroup('connection');
    if (this.transport) {
        this.transport.disconnect();
    } else {
        this.emit('disconnected');
    }
};

Client.prototype.send = function (data) {
    if (this.transport) {
        this.transport.send(data);
    }
    this.sm.track(data);
};

Client.prototype.sendMessage = function (data) {
    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }
    var message = new Message(data);

    this.emit('message:sent', message.toJSON());
    this.send(message);

    return data.id;
};

Client.prototype.sendPresence = function (data) {
    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }
    this.send(new Presence(data));

    return data.id;
};

Client.prototype.sendIq = function (data, cb) {
    var result, respEvent, allowed, dest;
    var self = this;

    data = data || {};
    if (!data.id) {
        data.id = this.nextId();
    }

    var iq = (!data.toJSON) ? new Iq(data) : data;

    if (data.type === 'error' || data.type === 'result') {
        this.send(iq);
        return;
    }

    dest = new JID(data.to);
    allowed = {};
    allowed[''] = true;
    allowed[dest.full] = true;
    allowed[dest.bare] = true;
    allowed[dest.domain] = true;
    allowed[self.jid.bare] = true;
    allowed[self.jid.domain] = true;

    respEvent = 'id:' + data.id;
    result = new Promise(function (resolve, reject) {
        var handler = function (res) {
            if (!allowed[res.from.full]) {
                return;
            }

            self.off(respEvent, handler);
            if (!res.error) {
                resolve(res);
            } else {
                reject(res);
            }
        };
        self.on(respEvent, 'session', handler);
    });

    this.send(iq);

    return result.timeout(self.config.timeout * 1000 || 15000)
        .catch(Promise.TimeoutError, function () {
            throw {type: 'error', error: {condition: 'timeout'}};
        })
        .nodeify(cb);
};

Client.prototype.sendStreamError = function (data) {
    data = data || {};

    var error = new StreamError(data);

    this.emit('stream:error', error);
    this.send(error);
    this.disconnect();
};

Client.prototype.JID = function (jid) {
    return new JID(jid);
};


module.exports = Client;

},{"./sm":45,"./stanza/bind":47,"./stanza/error":58,"./stanza/iq":66,"./stanza/message":71,"./stanza/presence":77,"./stanza/sasl":90,"./stanza/session":91,"./stanza/sm":93,"./stanza/stream":94,"./stanza/streamError":95,"./stanza/streamFeatures":96,"./transports/bosh":102,"./transports/old-websocket":103,"./transports/websocket":104,"alt-sasl-digest-md5":105,"async":106,"atob":107,"bluebird":110,"btoa":170,"hostmeta":171,"node-uuid":209,"sasl-anonymous":211,"sasl-external":213,"sasl-plain":215,"sasl-scram-sha-1":216,"saslmechanisms":221,"underscore":222,"util":169,"wildemitter":224,"xmpp-jid":225}],3:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:attention:0');


    client.getAttention = function (jid, opts) {
        opts = opts || {};
        opts.to = jid;
        opts.type = 'headline';
        opts.attention = true;
        client.sendMessage(opts);
    };

    client.on('message', function (msg) {
        if (msg.attention) {
            client.emit('attention', msg);
        }
    });
};

},{}],4:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/avatar');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:avatar:metadata+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'urn:xmpp:avatar:metadata') {
            return;
        }

        client.emit('avatar', {
            jid: msg.from,
            source: 'pubsub',
            avatars: msg.event.updated.published[0].avatars
        });
    });

    client.on('presence', function (pres) {
        if (pres.avatarId) {
            client.emit('avatar', {
                jid: pres.from,
                source: 'vcard',
                avatars: [{
                    id: pres.avatarId
                }]
            });
        }
    });

    client.publishAvatar = function (id, data, cb) {
        return this.publish('', 'urn:xmpp:avatar:data', {
            id: id,
            avatarData: data
        }, cb);
    };

    client.useAvatars = function (info, cb) {
        return this.publish('', 'urn:xmpp:avatar:metadata', {
            id: 'current',
            avatars: info
        }, cb);
    };

    client.getAvatar = function (jid, id, cb) {
        return this.getItem(jid, 'urn:xmpp:avatar:data', id, cb);
    };
};

},{"../stanza/avatar":46}],5:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/blocking');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:blocking');

    client.block = function (jid, cb) {
        return client.sendIq({
            type: 'set',
            block: {
                jids: [jid]
            }
        }, cb);
    };

    client.unblock = function (jid, cb) {
        return client.sendIq({
            type: 'set',
            unblock: {
                jids: [jid]
            }
        }, cb);
    };

    client.getBlocked = function (cb) {
        return client.sendIq({
            type: 'get',
            blockList: true
        }, cb);
    };

    client.on('iq:set:block', function (iq) {
        client.emit('block', {
            jids: iq.block.jids || []
        });
        client.sendIq(iq.resultReply());
    });

    client.on('iq:set:unblock', function (iq) {
        client.emit('unblock', {
            jids: iq.unblock.jids || []
        });
        client.sendIq(iq.resultReply());
    });
};

},{"../stanza/blocking":48}],6:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/bob');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:bob');

    client.getBits = function (jid, cid, cb) {
        return client.sendIq({
            to: jid,
            type: 'get',
            bob: {
                cid: cid
            }
        }, cb);
    };
};

},{"../stanza/bob":49}],7:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/bookmarks');

var _ = _dereq_('underscore');
var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.getBookmarks = function (cb) {
        return this.getPrivateData({bookmarks: true}, cb);
    };

    client.setBookmarks = function (opts, cb) {
        return this.setPrivateData({bookmarks: opts}, cb);
    };

    client.addBookmark = function (bookmark, cb) {
        bookmark.jid = new JID(bookmark.jid);

        return this.getBookmarks().then(function (res) {
            var bookmarks = res.privateStorage.bookmarks.conferences || [];
            var existing = _.filter(bookmarks, function (bm) {
                return bm.jid.bare === bookmark.jid.bare;
            });

            if (existing.length) {
                _.extend(existing[0], bookmark);
            } else {
                bookmarks.push(bookmark);
            }

            return client.setBookmarks({conferences: bookmarks});
        }).nodeify(cb);
    };

    client.removeBookmark = function (jid, cb) {
        jid = new JID(jid);
        return this.getBookmarks().then(function (res) {
            var bookmarks = res.privateStorage.bookmarks.conferences || [];
            bookmarks = _.filter(bookmarks, function (bm) {
                return jid.bare !== bm.jid.bare;
            });
            return client.setBookmarks({conferences: bookmarks});
        }).nodeify(cb);
    };
};

},{"../stanza/bookmarks":50,"underscore":222,"xmpp-jid":225}],8:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/carbons');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:carbons:2');

    client.enableCarbons = function (cb) {
        return this.sendIq({
            type: 'set',
            enableCarbons: true
        }, cb);
    };

    client.disableCarbons = function (cb) {
        return this.sendIq({
            type: 'set',
            disableCarbons: true
        }, cb);
    };

    client.on('message', function (msg) {
        if (msg.carbonSent) {
            return client.emit('carbon:sent', msg);
        }
        if (msg.carbonReceived) {
            return client.emit('carbon:received', msg);
        }
    });

    client.on('carbon:*', function (name, carbon) {
        var dir = name.split(':')[1];

        if (carbon.from.bare !== client.jid.bare) {
            return;
        }

        var msg, delay;
        if (dir === 'received') {
            msg = carbon.carbonReceived.forwarded.message;
            delay = carbon.carbonReceived.forwarded.delay;
        } else {
            msg = carbon.carbonSent.forwarded.message;
            delay = carbon.carbonSent.forwarded.delay;
        }

        if (!msg.delay) {
            if (delay) {
                msg.delay.stamp = delay.stamp;
            } else {
                msg.delay = {
                    stamp: new Date(Date.now())
                };
            }
        }

        msg.carbon = true;

        // Treat the carbon copied message however we would
        // have originally treated it ourself.
        if (msg.from.bare === client.jid.bare) {
            client.emit('message:sent', msg);
        } else {
            client.emit('message', msg);
        }
    });
};

},{"../stanza/carbons":53}],9:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/chatstates');

    client.on('message', function (msg) {
        if (msg.chatState) {
            client.emit('chat:state', {
                to: msg.to,
                from: msg.from,
                chatState: msg.chatState
            });
            client.emit('chatState', {
                to: msg.to,
                from: msg.from,
                chatState: msg.chatState
            });
        }
    });
};

},{}],10:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/command');

var NS = 'http://jabber.org/protocol/commands';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addItem({
        name: 'Ad-Hoc Commands',
        node: NS
    });


    client.getCommands = function (jid, cb) {
        return client.getDiscoItems(jid, NS, cb);
    };
};

},{"../stanza/command":54}],11:[function(_dereq_,module,exports){
'use strict';


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:message-correct:0');

    client.on('message', function (msg) {
        if (msg.replace) {
            client.emit('replace', msg);
            client.emit('replace:' + msg.id, msg);
        }
    });
};

},{}],12:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/dataforms');


module.exports = function (client) {
    client.disco.addFeature('jabber:x:data');
    client.disco.addFeature('urn:xmpp:media-element');
    client.disco.addFeature('http://jabber.org/protocol/xdata-validate');

    client.on('message', function (msg) {
        if (msg.form) {
            client.emit('dataform', msg);
        }
    });
};

},{"../stanza/dataforms":55}],13:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/delayed');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:delay');
};

},{"../stanza/delayed":56}],14:[function(_dereq_,module,exports){
(function (Buffer){
'use strict';

var _ = _dereq_('underscore');
var utf8 = _dereq_('utf8');
var hashes = _dereq_('iana-hashes');

_dereq_('../stanza/disco');
_dereq_('../stanza/caps');


function generateVerString(info, hash) {
    var S = '';
    var features = info.features.sort();
    var identities = [];
    var formTypes = {};
    var formOrder = [];

    _.forEach(info.identities, function (identity) {
        identities.push([
            identity.category || '',
            identity.type || '',
            identity.lang || '',
            identity.name || ''
        ].join('/'));
    });

    var idLen = identities.length;
    var featureLen = features.length;

    identities = _.unique(identities, true);
    features = _.unique(features, true);

    if (featureLen !== features.length || idLen !== identities.length) {
        return false;
    }


    S += identities.join('<') + '<';
    S += features.join('<') + '<';


    var illFormed = false;
    _.forEach(info.extensions, function (ext) {
        var fields = ext.fields;
        for (var i = 0, len = fields.length; i < len; i++) {
            if (fields[i].name === 'FORM_TYPE' && fields[i].type === 'hidden') {
                var name = fields[i].value;
                if (formTypes[name]) {
                    illFormed = true;
                    return;
                }
                formTypes[name] = ext;
                formOrder.push(name);
                return;
            }
        }
    });
    if (illFormed) {
        return false;
    }

    formOrder.sort();

    _.forEach(formOrder, function (name) {
        var ext = formTypes[name];
        var fields = {};
        var fieldOrder = [];

        S += '<' + name;

        _.forEach(ext.fields, function (field) {
            var fieldName = field.name;
            if (fieldName !== 'FORM_TYPE') {
                var values = field.value || '';
                if (typeof values !== 'object') {
                    values = values.split('\n');
                }
                fields[fieldName] = values.sort();
                fieldOrder.push(fieldName);
            }
        });

        fieldOrder.sort();

        _.forEach(fieldOrder, function (fieldName) {
            S += '<' + fieldName;
            _.forEach(fields[fieldName], function (val) {
                S += '<' + val;
            });
        });
    });

    var ver = hashes.createHash(hash).update(new Buffer(utf8.encode(S))).digest('base64');
    var padding = 4 - ver.length % 4;
    if (padding === 4) {
        padding = 0;
    }

    for (var i = 0; i < padding; i++) {
        ver += '=';
    }
    return ver;
}

function verifyVerString(info, hash, check) {
    var computed = generateVerString(info, hash);
    return computed && computed === check;
}


function Disco() {
    this.features = {};
    this.identities = {};
    this.extensions = {};
    this.items = {};
    this.caps = {};
}

Disco.prototype = {
    constructor: {
        value: Disco
    },
    addFeature: function (feature, node) {
        node = node || '';
        if (!this.features[node]) {
            this.features[node] = [];
        }
        this.features[node].push(feature);
    },
    addIdentity: function (identity, node) {
        node = node || '';
        if (!this.identities[node]) {
            this.identities[node] = [];
        }
        this.identities[node].push(identity);
    },
    addItem: function (item, node) {
        node = node || '';
        if (!this.items[node]) {
            this.items[node] = [];
        }
        this.items[node].push(item);
    },
    addExtension: function (form, node) {
        node = node || '';
        if (!this.extensions[node]) {
            this.extensions[node] = [];
        }
        this.extensions[node].push(form);
    }
};

module.exports = function (client) {
    client.disco = new Disco(client);

    client.disco.addFeature('http://jabber.org/protocol/disco#info');
    client.disco.addIdentity({
        category: 'client',
        type: 'web'
    });

    client.getDiscoInfo = function (jid, node, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            discoInfo: {
                node: node
            }
        }, cb);
    };

    client.getDiscoItems = function (jid, node, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            discoItems: {
                node: node
            }
        }, cb);
    };

    client.updateCaps = function () {
        var node = this.config.capsNode || 'https://stanza.io';
        var data = JSON.parse(JSON.stringify({
            identities: this.disco.identities[''],
            features: this.disco.features[''],
            extensions: this.disco.extensions['']
        }));

        var ver = generateVerString(data, 'sha-1');

        this.disco.caps = {
            node: node,
            hash: 'sha-1',
            ver: ver
        };

        node = node + '#' + ver;
        this.disco.features[node] = data.features;
        this.disco.identities[node] = data.identities;
        this.disco.extensions[node] = data.extensions;

        return client.getCurrentCaps();
    };

    client.getCurrentCaps = function () {
        var caps = client.disco.caps;
        if (!caps.ver) {
            return {ver: null, discoInfo: null};
        }

        var node = caps.node + '#' + caps.ver;
        return {
            ver: caps.ver,
            discoInfo: {
                identities: client.disco.identities[node],
                features: client.disco.features[node],
                extensions: client.disco.extensions[node]
            }
        };
    };

    client.on('presence', function (pres) {
        if (pres.caps) {
            client.emit('disco:caps', pres);
        }
    });

    client.on('iq:get:discoInfo', function (iq) {
        var node = iq.discoInfo.node || '';
        var reportedNode = iq.discoInfo.node || '';

        if (node === client.disco.caps.node + '#' + client.disco.caps.ver) {
            reportedNode = node;
            node = '';
        }

        client.sendIq(iq.resultReply({
            discoInfo: {
                node: reportedNode,
                identities: client.disco.identities[node] || [],
                features: client.disco.features[node] || [],
                extensions: client.disco.extensions[node] || []
            }
        }));
    });

    client.on('iq:get:discoItems', function (iq) {
        var node = iq.discoItems.node;
        client.sendIq(iq.resultReply({
            discoItems: {
                node: node,
                items: client.disco.items[node] || []
            }
        }));
    });

    client.verifyVerString = verifyVerString;
    client.generateVerString = generateVerString;

    // Ensure we always have some caps data
    client.updateCaps();
};

}).call(this,_dereq_("buffer").Buffer)
},{"../stanza/caps":52,"../stanza/disco":57,"buffer":148,"iana-hashes":173,"underscore":222,"utf8":223}],15:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('jid\\20escaping');
};

},{}],16:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/extdisco');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:extdisco:1');

    client.getServices = function (jid, type, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            services: {
                type: type
            }
        }, cb);
    };

    client.getServiceCredentials = function (jid, host, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            credentials: {
                service: {
                    host: host
                }
            }
        }, cb);
    };
};

},{"../stanza/extdisco":59}],17:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/forwarded');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:forward:0');
};

},{"../stanza/forwarded":61}],18:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/geoloc');


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/geoloc');
    client.disco.addFeature('http://jabber.org/protocol/geoloc+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'http://jabber.org/protocol/geoloc') {
            return;
        }

        client.emit('geoloc', {
            jid: msg.from,
            geoloc: msg.event.updated.published[0].geoloc
        });
    });

    client.publishGeoLoc = function (data, cb) {
        return this.publish('', 'http://jabber.org/protocol/geoloc', {
            geoloc: data
        }, cb);
    };
};

},{"../stanza/geoloc":63}],19:[function(_dereq_,module,exports){
'use strict';

var hashes = _dereq_('iana-hashes');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:hashes:1');

    var names = hashes.getHashes();
    names.forEach(function (name) {
        client.disco.addFeature('urn:xmpp:hash-function-text-names:' + name);
    });
};

},{"iana-hashes":173}],20:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:idle:1');
};

},{}],21:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    // We always need this one first
    client.use(_dereq_('./disco'));

    client.use(_dereq_('./attention'));
    client.use(_dereq_('./avatar'));
    client.use(_dereq_('./blocking'));
    client.use(_dereq_('./bob'));
    client.use(_dereq_('./bookmarks'));
    client.use(_dereq_('./carbons'));
    client.use(_dereq_('./chatstates'));
    client.use(_dereq_('./command'));
    client.use(_dereq_('./correction'));
    client.use(_dereq_('./dataforms'));
    client.use(_dereq_('./delayed'));
    client.use(_dereq_('./escaping'));
    client.use(_dereq_('./extdisco'));
    client.use(_dereq_('./forwarding'));
    client.use(_dereq_('./geoloc'));
    client.use(_dereq_('./hashes'));
    client.use(_dereq_('./idle'));
    client.use(_dereq_('./invisible'));
    client.use(_dereq_('./jingle'));
    client.use(_dereq_('./json'));
    client.use(_dereq_('./keepalive'));
    client.use(_dereq_('./logging'));
    client.use(_dereq_('./mam'));
    client.use(_dereq_('./muc'));
    client.use(_dereq_('./mood'));
    client.use(_dereq_('./nick'));
    client.use(_dereq_('./oob'));
    client.use(_dereq_('./ping'));
    client.use(_dereq_('./private'));
    client.use(_dereq_('./psa'));
    client.use(_dereq_('./pubsub'));
    client.use(_dereq_('./reach'));
    client.use(_dereq_('./receipts'));
    client.use(_dereq_('./register'));
    client.use(_dereq_('./roster'));
    client.use(_dereq_('./rtt'));
    client.use(_dereq_('./shim'));
    client.use(_dereq_('./time'));
    client.use(_dereq_('./vcard'));
    client.use(_dereq_('./version'));
};

},{"./attention":3,"./avatar":4,"./blocking":5,"./bob":6,"./bookmarks":7,"./carbons":8,"./chatstates":9,"./command":10,"./correction":11,"./dataforms":12,"./delayed":13,"./disco":14,"./escaping":15,"./extdisco":16,"./forwarding":17,"./geoloc":18,"./hashes":19,"./idle":20,"./invisible":22,"./jingle":23,"./json":24,"./keepalive":25,"./logging":26,"./mam":27,"./mood":28,"./muc":29,"./nick":30,"./oob":31,"./ping":32,"./private":33,"./psa":34,"./pubsub":35,"./reach":36,"./receipts":37,"./register":38,"./roster":39,"./rtt":40,"./shim":41,"./time":42,"./vcard":43,"./version":44}],22:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/visibility');


module.exports = function (client) {
    client.goInvisible = function (cb) {
        return this.sendIq({
            type: 'set',
            invisible: true
        }, cb);
    };

    client.goVisible = function (cb) {
        return this.sendIq({
            type: 'set',
            visible: true
        }, cb);
    };
};

},{"../stanza/visibility":101}],23:[function(_dereq_,module,exports){
'use strict';

var Jingle = _dereq_('jingle');

_dereq_('../stanza/jingle');
_dereq_('../stanza/rtp');
_dereq_('../stanza/iceUdp');
_dereq_('../stanza/file');


module.exports = function (client) {
    var jingle = client.jingle = new Jingle();

    jingle.capabilities.forEach(function (cap) {
        client.disco.addFeature(cap);
    });

    var mappedEvents = [
        'outgoing', 'incoming', 'accepted', 'terminated',
        'ringing', 'mute', 'unmute', 'hold', 'resumed'
    ];
    mappedEvents.forEach(function (event) {
        jingle.on(event, function (session, arg1) {
            client.emit('jingle:' + event, session, arg1);
        });
    });

    jingle.on('localStream', function (stream) {
        client.emit('jingle:localstream:added', stream);
    });

    jingle.on('localStreamStopped', function () {
        client.emit('jingle:localstream:removed');
    });

    jingle.on('peerStreamAdded', function (session, stream) {
        client.emit('jingle:remotestream:added', session, stream);
    });

    jingle.on('peerStreamRemoved', function (session, stream) {
        client.emit('jingle:remotestream:removed', session, stream);
    });

    jingle.on('send', function (data) {
        client.sendIq(data, function (err) {
            if (err) {
                client.emit('jingle:error', err);
            }
        });
    });

    client.on('iq:set:jingle', function (data) {
        jingle.process(data);
    });

    client.on('unavailable', function (pres) {
        var peer = pres.from.full;
        jingle.endPeerSessions(peer, true);
    });

    client.call = function (peer) {
        peer = peer.full || peer;
        var sess = jingle.createMediaSession(peer);
        client.sendPresence({to: peer});
        sess.start();
        return sess;
    };

    client.discoverICEServers = function (cb) {
        return this.getServices(client.config.server).then(function (res) {
            var services = res.services.services;
            var discovered = [];

            for (var i = 0; i < services.length; i++) {
                var service = services[i];
                var ice = {};
                if (service.type === 'stun') {
                    ice.url = 'stun:' + service.host;
                    if (service.port) {
                        ice.url += ':' + service.port;
                    }
                    discovered.push(ice);
                    client.jingle.addICEServer(ice);
                } else if (service.type === 'turn') {
                    ice.url = 'turn:' + service.host;
                    if (service.port) {
                        ice.url += ':' + service.port;
                    }
                    if (service.transport && service.transport !== 'udp') {
                        ice.url += '?transport=' + service.transport;
                    }

                    if (service.username) {
                        ice.username = service.username;
                    }
                    if (service.password) {
                        ice.credential = service.password;
                    }
                    discovered.push(ice);
                    client.jingle.addICEServer(ice);
                }
            }

            return discovered;
        }).nodeify(cb);
    };
};

},{"../stanza/file":60,"../stanza/iceUdp":65,"../stanza/jingle":67,"../stanza/rtp":88,"jingle":187}],24:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/json');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:json:0');
};

},{"../stanza/json":68}],25:[function(_dereq_,module,exports){
'use strict';

var Promise = _dereq_('bluebird');


function checkConnection(client, timeout) {
    return new Promise(function (resolve, reject) {
        if (client.sm.started) {
            client.once('stream:management:ack', resolve);
            client.sm.request();
        } else {
            client.ping().then(resolve).catch(function (err) {
                if (err.error && err.error.condition !== 'timeout') {
                    resolve();
                } else {
                    reject();
                }
            });
        }
    }).timeout(timeout * 1000 || 15000);
}


module.exports = function (client) {
    client.enableKeepAlive = function (opts) {
        opts = opts || {};

        // Ping every 5 minutes
        opts.interval = opts.interval || 300;

        // Disconnect if no response in 15 seconds
        opts.timeout = opts.timeout || 15;

        function keepalive() {
            if (client.sessionStarted) {
                checkConnection(client, opts.timeout).catch(function () {
                    client.sendStreamError({
                        condition: 'connection-timeout'
                    });
                });
            }
        }

        client._keepAliveInterval = setInterval(keepalive, opts.interval * 1000);
    };

    client.disableKeepAlive = function () {
        if (client._keepAliveInterval) {
            clearInterval(client._keepAliveInterval);
            delete client._keepAliveInterval;
        }
    };

    client.on('disconnected', function () {
        client.disableKeepAlive();
    });
};

},{"bluebird":110}],26:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/logging');


module.exports = function (client) {
    client.disco.addFeature('', 'urn:xmpp:eventlog');

    client.sendLog = function (jid, logData) {
        client.sendMessage({
            to: jid,
            type: 'normal',
            log: logData
        });
    };
};

},{"../stanza/logging":69}],27:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/mam');

var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:mam:tmp');

    client.getHistory = function (opts, cb) {
        var self = this;
        var queryid = this.nextId();

        opts = opts || {};
        opts.queryid = queryid;

        var to = opts.to || '';
        delete opts.to;

        var dest = new JID(to || client.jid.bare);
        var allowed = {};
        allowed[''] = true;
        allowed[dest.full] = true;
        allowed[dest.bare] = true;
        allowed[dest.domain] = true;
        allowed[client.jid.bare] = true;
        allowed[client.jid.domain] = true;

        var mamResults = [];
        this.on('mam:' + queryid, 'session', function (msg) {
            if (!allowed[msg.from.full]) {
                return;
            }
            mamResults.push(msg);
        });

        return this.sendIq({
            type: 'get',
            to: to,
            id: queryid,
            mamQuery: opts
        }).then(function (resp) {
            resp.mamQuery.results = mamResults;
            return resp;
        }).finally(function () {
            self.off('mam:' + queryid);
        }).nodeify(cb);
    };

    client.getHistoryPreferences = function (cb) {
        return this.sendIq({
            type: 'get',
            mamPrefs: true
        }, cb);
    };

    client.setHistoryPreferences = function (opts, cb) {
        return this.sendIq({
            type: 'set',
            mamPrefs: opts
        }, cb);
    };

    client.on('message', function (msg) {
        if (msg.mam) {
            client.emit('mam:' + msg.mam.queryid, msg);
        }
    });
};

},{"../stanza/mam":70,"xmpp-jid":225}],28:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/mood');

var NS = 'http://jabber.org/protocol/mood';

module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }

        if (msg.event.updated.node !== NS) {
            return;
        }

        client.emit('mood', {
            jid: msg.from,
            mood: msg.event.updated.published[0].mood
        });
    });

    client.publishMood = function (mood, text, cb) {
        return this.publish('', NS, {
            mood: {
                value: mood,
                text: text
            }
        }, cb);
    };
};

},{"../stanza/mood":72}],29:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/muc');

var _ = _dereq_('underscore');
var JID = _dereq_('xmpp-jid').JID;


module.exports = function (client) {
    client.disco.addFeature('http://jabber.org/protocol/muc');
    client.disco.addFeature('jabber:x:conference');

    client.joinedRooms = {};

    function rejoinRooms() {
        _.each(client.joinedRooms, function (nick, room) {
            client.joinedRooms[room] = false;
            client.joinRoom(room, nick);
        });
    }
    client.on('session:started', rejoinRooms);
    client.on('stream:management:resumed', rejoinRooms);

    client.on('message', function (msg) {
        if (msg.muc) {
            if (msg.muc.invite) {
                client.emit('muc:invite', {
                    from: msg.muc.invite.from,
                    room: msg.from,
                    reason: msg.muc.invite.reason,
                    password: msg.muc.password,
                    thread: msg.muc.invite.thread,
                    type: 'mediated'
                });
            }
            if (msg.muc.destroyed) {
                client.emit('muc:destroyed', {
                    room: msg.from,
                    newRoom: msg.muc.destroyed.jid,
                    reason: msg.muc.destroyed.reason,
                    password: msg.muc.password
                });
            }
            if (msg.muc.decline) {
                client.emit('muc:declined', {
                    room: msg.from,
                    from: msg.muc.decline.from,
                    reason: msg.muc.decline.reason
                });
            }
        } else if (msg.mucInvite) {
            client.emit('muc:invite', {
                from: msg.from,
                room: msg.mucInvite.jid,
                reason: msg.mucInvite.reason,
                password: msg.mucInvite.password,
                thread: msg.mucInvite.thread,
                type: 'direct'
            });
        }

        if (msg.type === 'groupchat' && msg.subject) {
            client.emit('muc:subject', msg);
        }
    });

    client.on('presence', function (pres) {
        if (pres.joinMuc && pres.type === 'error') {
            client.emit('muc:error', pres);
        } else if (pres.muc) {
            var isSelf = pres.muc.codes && pres.muc.codes.indexOf('110') >= 0;
            if (pres.type === 'error') {
                client.emit('muc:error', pres);
            } else if (pres.type === 'unavailable') {
                client.emit('muc:unavailable', pres);
                if (isSelf) {
                    client.emit('muc:leave', pres);
                    delete client.joinedRooms[pres.from.bare];
                }
            } else {
                client.emit('muc:available', pres);
                if (isSelf && !client.joinedRooms[pres.from.bare]) {
                    client.emit('muc:join', pres);
                    client.joinedRooms[pres.from.bare] = pres.from.resource;
                }
            }
        }
    });

    client.joinRoom = function (room, nick, opts) {
        opts = opts || {};
        opts.to = room + '/' + nick;
        opts.caps = this.disco.caps;
        opts.joinMuc = opts.joinMuc || {};

        this.sendPresence(opts);
    };

    client.leaveRoom = function (room, nick, opts) {
        opts = opts || {};
        opts.to = room + '/' + nick;
        opts.type = 'unavailable';
        this.sendPresence(opts);
    };

    client.ban = function (room, jid, reason, cb) {
        client.setRoomAffiliation(room, jid, 'outcast', reason, cb);
    };

    client.kick = function (room, nick, reason, cb) {
        client.setRoomRole(room, nick, 'none', reason, cb);
    };

    client.invite = function (room, opts) {
        client.sendMessage({
            to: room,
            muc: {
                invites: opts
            }
        });
    };

    client.directInvite = function (room, opts) {
        opts.jid = room;
        client.sendMessage({
            to: opts.to,
            mucInvite: opts
        });
    };

    client.declineInvite = function (room, sender, reason) {
        client.sendMessage({
            to: room,
            muc: {
                decline: {
                    to: sender,
                    reason: reason
                }
            }
        });
    };

    client.changeNick = function (room, nick) {
        client.sendPresence({
            to: (new JID(room)).bare + '/' + nick
        });
    };

    client.setSubject = function (room, subject) {
        client.sendMessage({
            to: room,
            type: 'groupchat',
            subject: subject
        });
    };

    client.discoverReservedNick = function (room, cb) {
        client.getDiscoInfo(room, 'x-roomuser-item', function (err, res) {
            if (err) {
                return cb(err);
            }
            var ident = res.discoInfo.identities[0] || {};
            cb(null, ident.name);
        });
    };

    client.requestRoomVoice = function (room) {
        client.sendMessage({
            to: room,
            form: {
                fields: [
                    {
                        name: 'FORM_TYPE',
                        value: 'http://jabber.org/protocol/muc#request'
                    },
                    {
                        name: 'muc#role',
                        type: 'text-single',
                        value: 'participant'
                    }
                ]
            }
        });
    };

    client.setRoomAffiliation = function (room, jid, affiliation, reason, cb) {
        return this.sendIq({
            type: 'set',
            to: room,
            mucAdmin: {
                jid: jid,
                affiliation: affiliation,
                reason: reason
            }
        }, cb);
    };

    client.setRoomRole = function (room, nick, role, reason, cb) {
        return this.sendIq({
            type: 'set',
            to: room,
            mucAdmin: {
                nick: nick,
                role: role,
                reason: reason
            }
        }, cb);
    };

    client.getRoomMembers = function (room, opts, cb) {
        return this.sendIq({
            type: 'get',
            to: room,
            mucAdmin: opts
        }, cb);
    };

    client.getRoomConfig = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            mucOwner: true
        }, cb);
    };

    client.configureRoom = function (jid, form, cb) {
        if (!form.type) {
            form.type = 'submit';
        }
        return this.sendIq({
            to: jid,
            type: 'set',
            mucOwner: {
                form: form
            }
        }, cb);
    };

    client.getUniqueRoomName = function (jid, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            mucUnique: true
        }, cb);
    };
};

},{"../stanza/muc":73,"underscore":222,"xmpp-jid":225}],30:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/nick');

var NS = 'http://jabber.org/protocol/nick';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== NS) {
            return;
        }

        client.emit('nick', {
            jid: msg.from,
            nick: msg.event.updated.published[0].nick
        });
    });

    client.publishNick = function (nick, cb) {
        return this.publish('', NS, {
            nick: nick
        }, cb);
    };
};

},{"../stanza/nick":74}],31:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/oob');


module.exports = function (client) {
    client.disco.addFeature('jabber:x:oob');
};

},{"../stanza/oob":75}],32:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/ping');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:ping');

    client.on('iq:get:ping', function (iq) {
        client.sendIq(iq.resultReply());
    });

    client.ping = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            ping: true
        }, cb);
    };
};

},{"../stanza/ping":76}],33:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/private');


module.exports = function (client) {

    client.getPrivateData = function (opts, cb) {
        return this.sendIq({
            type: 'get',
            privateStorage: opts
        }, cb);
    };

    client.setPrivateData = function (opts, cb) {
        return this.sendIq({
            type: 'set',
            privateStorage: opts
        }, cb);
    };

};

},{"../stanza/private":78}],34:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/psa');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:psa');
};

},{"../stanza/psa":79}],35:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/pubsub');
_dereq_('../stanza/pubsubOwner');
_dereq_('../stanza/pubsubEvents');
_dereq_('../stanza/pubsubError');


module.exports = function (client) {

    client.on('message', function (msg) {
        if (msg.event) {
            client.emit('pubsub:event', msg);
            client.emit('pubsubEvent', msg);
        }
    });

    client.subscribeToNode = function (jid, opts, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                subscribe: {
                    node: opts.node,
                    jid: opts.jid || client.jid
                }
            }
        }, cb);
    };

    client.unsubscribeFromNode = function (jid, opts, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                unsubscribe: {
                    node: opts.node,
                    jid: opts.jid || client.jid.split('/')[0]
                }
            }
        }, cb);
    };

    client.publish = function (jid, node, item, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                publish: {
                    node: node,
                    item: item
                }
            }
        }, cb);
    };

    client.getItem = function (jid, node, id, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            pubsub: {
                retrieve: {
                    node: node,
                    item: id
                }
            }
        }, cb);
    };

    client.getItems = function (jid, node, opts, cb) {
        opts = opts || {};
        opts.node = node;
        return this.sendIq({
            type: 'get',
            to: jid,
            pubsub: {
                retrieve: {
                    node: node,
                    max: opts.max
                },
                rsm: opts.rsm
            }
        }, cb);
    };

    client.retract = function (jid, node, id, notify, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsub: {
                retract: {
                    node: node,
                    notify: notify,
                    id: id
                }
            }
        }, cb);
    };

    client.purgeNode = function (jid, node, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsubOwner: {
                purge: node
            }
        }, cb);
    };

    client.deleteNode = function (jid, node, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            pubsubOwner: {
                del: node
            }
        }, cb);
    };

    client.createNode = function (jid, node, config, cb) {
        var cmd = {
            type: 'set',
            to: jid,
            pubsubOwner: {
                create: node
            }
        };

        if (config) {
            cmd.pubsubOwner.config = {form: config};
        }

        return this.sendIq(cmd, cb);
    };
};

},{"../stanza/pubsub":80,"../stanza/pubsubError":81,"../stanza/pubsubEvents":82,"../stanza/pubsubOwner":83}],36:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/reach');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:reach:0');
    client.disco.addFeature('urn:xmpp:reach:0+notify');

    client.on('pubsub:event', function (msg) {
        if (!msg.event.updated) {
            return;
        }
        if (msg.event.updated.node !== 'urn:xmpp:reach:0') {
            return;
        }

        client.emit('reachability', {
            jid: msg.from,
            addresses: msg.event.updated.published[0].reach
        });
    });

    client.on('presence', function (pres) {
        if (!pres.reach || !pres.reach.length) {
            return;
        }

        client.emit('reachability', {
            jid: pres.from,
            addresses: pres.reach
        });
    });

    client.publishReachability = function (data, cb) {
        return this.publish('', 'urn:xmpp:reach:0', {
            reach: data
        }, cb);
    };
};

},{"../stanza/reach":84}],37:[function(_dereq_,module,exports){
'use strict';

module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:receipts');

    client.on('message', function (msg) {
        var ackTypes = {
            normal: true,
            chat: true,
            headline: true
        };
        if (ackTypes[msg.type] && msg.requestReceipt && !msg.receipt) {
            client.sendMessage({
                to: msg.from,
                receipt: msg.id,
                id: msg.id
            });
        }
        if (msg.receipt) {
            client.emit('receipt', msg);
            client.emit('receipt:' + msg.receipt);
        }
    });
};

},{}],38:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/register');


module.exports = function (client) {
    client.getAccountInfo = function (jid, cb) {
        return this.sendIq({
            type: 'get',
            to: jid,
            register: true
        }, cb);
    };

    client.updateAccount = function (jid, data, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            register: data
        }, cb);
    };

    client.deleteAccount = function (jid, cb) {
        return this.sendIq({
            type: 'set',
            to: jid,
            register: {
                remove: true
            }
        }, cb);
    };
};

},{"../stanza/register":85}],39:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/roster');


module.exports = function (client) {

    client.on('iq:set:roster', function (iq) {
        var allowed = {};
        allowed[''] = true;
        allowed[client.jid.bare] = true;
        allowed[client.jid.domain] = true;

        if (!allowed[iq.from.full]) {
            return client.sendIq(iq.errorReply({
                error: {
                    type: 'cancel',
                    condition: 'service-unavailable'
                }
            }));
        }

        client.emit('roster:update', iq);
        client.sendIq({
            id: iq.id,
            type: 'result'
        });
    });

    client.getRoster = function (cb) {
        var self = this;
        cb = cb || function () {};

        return client.sendIq({
            type: 'get',
            roster: {
                ver: self.config.rosterVer
            }
        }).then(function (resp) {
            if (resp.roster) {
                var ver = resp.roster.ver;
                if (ver) {
                    self.config.rosterVer = ver;
                    self.emit('roster:ver', ver);
                }
            }
            return resp;
        }).nodeify(cb);
    };

    client.updateRosterItem = function (item, cb) {
        return client.sendIq({
            type: 'set',
            roster: {
                items: [item]
            }
        }, cb);
    };

    client.removeRosterItem = function (jid, cb) {
        return client.updateRosterItem({jid: jid, subscription: 'remove'}, cb);
    };

    client.subscribe = function (jid) {
        client.sendPresence({type: 'subscribe', to: jid});
    };

    client.unsubscribe = function (jid) {
        client.sendPresence({type: 'unsubscribe', to: jid});
    };

    client.acceptSubscription = function (jid) {
        client.sendPresence({type: 'subscribed', to: jid});
    };

    client.denySubscription = function (jid) {
        client.sendPresence({type: 'unsubscribed', to: jid});
    };
};

},{"../stanza/roster":86}],40:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/rtt');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:rtt:0');

    client.on('message', function (msg) {
        if (msg.rtt) {
            client.emit('rtt', msg);
            client.emit('rtt:' + msg.rtt.event, msg);
        }
    });
};

},{"../stanza/rtt":89}],41:[function(_dereq_,module,exports){
_dereq_('../stanza/shim');

var NS = 'http://jabber.org/protocol/shim';


module.exports = function (client) {
    client.disco.addFeature(NS);
    client.disco.addFeature(NS + '#SubID', NS);
};

},{"../stanza/shim":92}],42:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/time');


module.exports = function (client) {
    client.disco.addFeature('urn:xmpp:time');

    client.getTime = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            time: true
        }, cb);
    };

    client.on('iq:get:time', function (iq) {
        var time = new Date();
        client.sendIq(iq.resultReply({
            time: {
                utc: time,
                tzo: time.getTimezoneOffset()
            }
        }));
    });
};

},{"../stanza/time":97}],43:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/vcard');


module.exports = function (client) {
    client.disco.addFeature('vcard-temp');

    client.getVCard = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            vCardTemp: true
        }, cb);
    };

    client.publishVCard = function (vcard, cb) {
        return this.sendIq({
            type: 'set',
            vCardTemp: vcard
        }, cb);
    };
};

},{"../stanza/vcard":99}],44:[function(_dereq_,module,exports){
'use strict';

_dereq_('../stanza/version');


module.exports = function (client) {
    client.disco.addFeature('jabber:iq:version');

    client.on('iq:get:version', function (iq) {
        client.sendIq(iq.resultReply({
            version: client.config.softwareVersion || {
                name: 'stanza.io'
            }
        }));
    });

    client.getSoftwareVersion = function (jid, cb) {
        return this.sendIq({
            to: jid,
            type: 'get',
            version: true
        }, cb);
    };
};

},{"../stanza/version":100}],45:[function(_dereq_,module,exports){
'use strict';

var SM = _dereq_('./stanza/sm');
var MAX_SEQ = Math.pow(2, 32);


function mod(v, n) {
    return ((v % n) + n) % n;
}


function StreamManagement(client) {
    this.client = client;
    this.id = false;
    this.allowResume = true;
    this.started = false;
    this.lastAck = 0;
    this.handled = 0;
    this.windowSize = 1;
    this.unacked = [];
    this.pendingAck = false;
}

StreamManagement.prototype = {
    constructor: {
        value: StreamManagement
    },
    enable: function () {
        var enable = new SM.Enable();
        enable.resume = this.allowResume;
        this.client.send(enable);
        this.handled = 0;
        this.started = true;
    },
    resume: function () {
        var resume = new SM.Resume({
            h: this.handled,
            previd: this.id
        });
        this.client.send(resume);
        this.started = true;
    },
    enabled: function (resp) {
        this.id = resp.id;
    },
    resumed: function (resp) {
        this.id = resp.previd;
        if (resp.h) {
            this.process(resp, true);
        }
    },
    failed: function () {
        this.started = false;
        this.id = false;
        this.lastAck = 0;
        this.handled = 0;
        this.unacked = [];
    },
    ack: function () {
        this.client.send(new SM.Ack({
            h: this.handled
        }));
    },
    request: function () {
        this.pendingAck = true;
        this.client.send(new SM.Request());
    },
    process: function (ack, resend) {
        var self = this;
        var numAcked = mod(ack.h - this.lastAck, MAX_SEQ);

        this.pendingAck = false;

        for (var i = 0; i < numAcked && this.unacked.length > 0; i++) {
            this.client.emit('stanza:acked', this.unacked.shift());
        }
        this.lastAck = ack.h;

        if (resend) {
            var resendUnacked = this.unacked;
            this.unacked = [];
            resendUnacked.forEach(function (stanza) {
                self.client.send(stanza);
            });
        }

        if (this.needAck()) {
            this.request();
        }
    },
    track: function (stanza) {
        var name = stanza._name;
        var acceptable = {
            message: true,
            presence: true,
            iq: true
        };

        if (this.started && acceptable[name]) {
            this.unacked.push(stanza);
            if (this.needAck()) {
                this.request();
            }
        }
    },
    handle: function () {
        if (this.started) {
            this.handled = mod(this.handled + 1, MAX_SEQ);
        }
    },
    needAck: function () {
        return !this.pendingAck && this.unacked.length >= this.windowSize;
    }
};

module.exports = StreamManagement;

},{"./stanza/sm":93}],46:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;

var Avatar = module.exports = stanza.define({
    name: 'avatar',
    namespace: 'urn:xmpp:avatar:metadata',
    element: 'info',
    fields: {
        id: stanza.attribute('id'),
        bytes: stanza.attribute('bytes'),
        height: stanza.attribute('height'),
        width: stanza.attribute('width'),
        type: stanza.attribute('type', 'image/png'),
        url: stanza.attribute('url')
    }
});


var avatars = {
    get: function () {
        var metadata = stanza.find(this.xml, 'urn:xmpp:avatar:metadata', 'metadata');
        var results = [];
        if (metadata.length) {
            var avatars = stanza.find(metadata[0], 'urn:xmpp:avatar:metadata', 'info');
            _.forEach(avatars, function (info) {
                results.push(new Avatar({}, info));
            });
        }
        return results;
    },
    set: function (value) {
        var metadata = stanza.findOrCreate(this.xml, 'urn:xmpp:avatar:metadata', 'metadata');
        stanza.setAttribute(metadata, 'xmlns', 'urn:xmpp:avatar:metadata');
        _.forEach(value, function (info) {
            var avatar = new Avatar(info);
            metadata.appendChild(avatar.xml);
        });
    }
};

stanza.add(Item, 'avatars', avatars);
stanza.add(EventItem, 'avatars', avatars);
stanza.add(Item, 'avatarData', stanza.subText('urn:xmpp:avatar:data', 'data'));
stanza.add(EventItem, 'avatarData', stanza.subText('urn:xmpp:avatar:data', 'data'));

},{"./pubsub":80,"./pubsubEvents":82,"jxt":204,"underscore":222}],47:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var StreamFeatures = _dereq_('./streamFeatures');
var util = _dereq_('./util');

var NS = 'urn:ietf:params:xml:ns:xmpp-bind';

var Bind = module.exports = stanza.define({
    name: 'bind',
    namespace: NS,
    element: 'bind',
    fields: {
        resource: stanza.subText(NS, 'resource'),
        jid: util.jidSub(NS, 'jid')
    }
});

stanza.extend(Iq, Bind);
stanza.extend(StreamFeatures, Bind);

},{"./iq":66,"./streamFeatures":96,"./util":98,"jxt":204}],48:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var JID = _dereq_('xmpp-jid').JID;

var NS = 'urn:xmpp:blocking';


var jids = {
    get: function () {
        var result = [];
        var items = stanza.find(this.xml, NS, 'item');
        if (!items.length) {
            return result;
        }

        items.forEach(function (item) {
            result.push(new JID(stanza.getAttribute(item, 'jid', '')));
        });

        return result;
    },
    set: function (values) {
        var self = this;
        values.forEach(function (value) {
            var item = stanza.createElement(NS, 'item', NS);
            stanza.setAttribute(item, 'jid', value.toString());
            self.xml.appendChild(item);
        });
    }
};

exports.Block = stanza.define({
    name: 'block',
    namespace: NS,
    element: 'block',
    fields: {
        jids: jids
    }
});

exports.Unblock = stanza.define({
    name: 'unblock',
    namespace: NS,
    element: 'unblock',
    fields: {
        jids: jids
    }
});

exports.BlockList = stanza.define({
    name: 'blockList',
    namespace: NS,
    element: 'blocklist',
    fields: {
        jids: jids
    }
});


stanza.extend(Iq, exports.Block);
stanza.extend(Iq, exports.Unblock);
stanza.extend(Iq, exports.BlockList);

},{"./iq":66,"jxt":204,"xmpp-jid":225}],49:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Iq = _dereq_('./iq');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');

var NS = 'urn:xmpp:bob';


var BOB = module.exports = stanza.define({
    name: 'bob',
    namespace: NS,
    element: 'data',
    fields: {
        cid: stanza.attribute('cid'),
        maxAge: stanza.numberAttribute('max-age'),
        type: stanza.attribute('type'),
        data: stanza.text()
    }
});


stanza.extend(Iq, BOB);
stanza.extend(Message, BOB);
stanza.extend(Presence, BOB);

},{"./iq":66,"./message":71,"./presence":77,"jxt":204}],50:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var PrivateStorage = _dereq_('./private');


var Conference = stanza.define({
    name: '_conference',
    namespace: 'storage:bookmarks',
    element: 'conference',
    fields: {
        name: stanza.attribute('name'),
        autoJoin: stanza.boolAttribute('autojoin'),
        jid: util.jidAttribute('jid'),
        nick: stanza.subText('storage:bookmarks', 'nick')
    }
});

var Bookmarks = module.exports = stanza.define({
    name: 'bookmarks',
    namespace: 'storage:bookmarks',
    element: 'storage'
});


stanza.extend(PrivateStorage, Bookmarks);
stanza.extend(Bookmarks, Conference, 'conferences');

},{"./private":78,"./util":98,"jxt":204}],51:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');

var NS = 'http://jabber.org/protocol/httpbind';
var XMPP_NS = 'urn:xmpp:xbosh';


module.exports = stanza.define({
    name: 'bosh',
    namespace: NS,
    element: 'body',
    prefixes: {
        xmpp: XMPP_NS
    },
    fields: {
        accept: stanza.attribute('accept'),
        ack: stanza.numberAttribute('ack'),
        authid: stanza.attribute('authid'),
        charsets: stanza.attribute('charsets'),
        condition: stanza.attribute('condition'),
        content: stanza.attribute('content'),
        from: util.jidAttribute('from', true),
        hold: stanza.numberAttribute('hold'),
        inactivity: stanza.numberAttribute('inactivity'),
        key: stanza.attribute('key'),
        maxpause: stanza.numberAttribute('maxpause'),
        newKey: stanza.attribute('newkey'),
        pause: stanza.numberAttribute('pause'),
        polling: stanza.numberAttribute('polling'),
        resport: stanza.numberAttribute('report'),
        requests: stanza.numberAttribute('requests'),
        rid: stanza.numberAttribute('rid'),
        sid: stanza.attribute('sid'),
        stream: stanza.attribute('stream'),
        time: stanza.attribute('time'),
        to: util.jidAttribute('to', true),
        type: stanza.attribute('type'),
        ver: stanza.attribute('ver'),
        wait: stanza.numberAttribute('wait'),
        uri: stanza.subText(NS, 'uri'),
        lang: stanza.langAttribute(),
        // These three should be using namespaced attributes, but browsers are stupid
        // when it comes to serializing attributes with namespaces
        version: stanza.attribute('xmpp:version', '1.0'),
        restart: stanza.attribute('xmpp:restart'),
        restartLogic: stanza.boolAttribute('xmpp:restartLogic'),
        payload: {
            get: function () {
                var results = [];
                for (var i = 0, len = this.xml.childNodes.length; i < len; i++)  {
                    var obj = stanza.build(this.xml.childNodes[i]);
                    if (obj !== undefined) {
                        results.push(obj);
                    }
                }
                return results;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (stanza) {
                    self.xml.appendChild(stanza.xml);
                });
            }
        }
    }
});

},{"./util":98,"jxt":204}],52:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Presence = _dereq_('./presence');
var StreamFeatures = _dereq_('./streamFeatures');


var Caps = module.exports = stanza.define({
    name: 'caps',
    namespace: 'http://jabber.org/protocol/caps',
    element: 'c',
    fields: {
        ver: stanza.attribute('ver'),
        node: stanza.attribute('node'),
        hash: stanza.attribute('hash'),
        ext: stanza.attribute('ext')
    }
});

stanza.extend(Presence, Caps);
stanza.extend(StreamFeatures, Caps);

},{"./presence":77,"./streamFeatures":96,"jxt":204}],53:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Iq = _dereq_('./iq');
var Forwarded = _dereq_('./forwarded');


exports.Sent = stanza.define({
    name: 'carbonSent',
    eventName: 'carbon:sent',
    namespace: 'urn:xmpp:carbons:2',
    element: 'sent'
});

exports.Received = stanza.define({
    name: 'carbonReceived',
    eventName: 'carbon:received',
    namespace: 'urn:xmpp:carbons:2',
    element: 'received'
});

exports.Private = stanza.define({
    name: 'carbonPrivate',
    eventName: 'carbon:private',
    namespace: 'urn:xmpp:carbons:2',
    element: 'private'
});

exports.Enable = stanza.define({
    name: 'enableCarbons',
    namespace: 'urn:xmpp:carbons:2',
    element: 'enable'
});

exports.Disable = stanza.define({
    name: 'disableCarbons',
    namespace: 'urn:xmpp:carbons:2',
    element: 'disable'
});


stanza.extend(exports.Sent, Forwarded);
stanza.extend(exports.Received, Forwarded);
stanza.extend(Message, exports.Sent);
stanza.extend(Message, exports.Received);
stanza.extend(Message, exports.Private);
stanza.extend(Iq, exports.Enable);
stanza.extend(Iq, exports.Disable);

},{"./forwarded":61,"./iq":66,"./message":71,"jxt":204}],54:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');

var DataForm = _dereq_('./dataforms').DataForm;
var ErrorStanza = _dereq_('./error');
var Iq = _dereq_('./iq');

var NS = 'http://jabber.org/protocol/commands';
var ACTIONS = ['next', 'prev', 'complete', 'cancel'];
var CONDITIONS = [
    'bad-action', 'bad-locale', 'bad-payload', 'bad-sessionid',
    'malformed-action', 'session-expired'
];


var Command = module.exports = stanza.define({
    name: 'command',
    namespace: NS,
    element: 'command',
    fields: {
        action: stanza.attribute('action'),
        node: stanza.attribute('node'),
        sessionid: stanza.attribute('sessionid'),
        status: stanza.attribute('status'),
        noteType: stanza.subAttribute(NS, 'note', 'type'),
        note: stanza.subText(NS, 'note'),
        execute: stanza.subAttribute(NS, 'actions', 'execute'),
        actions: {
            get: function () {
                var result = [];
                var actionSet = stanza.find(this.xml, NS, 'actions');
                if (!actionSet.length) {
                    return [];
                }
                ACTIONS.forEach(function (action) {
                    var existing = stanza.find(actionSet[0], NS, action);
                    if (existing.length) {
                        result.push(action);
                    }
                });
                return result;
            },
            set: function (values) {
                var actionSet = stanza.findOrCreate(this.xml, NS, 'actions');
                for (var i = 0, len = actionSet.childNodes.length; i < len; i++) {
                    actionSet.removeChild(actionSet.childNodes[i]);
                }
                values.forEach(function (value) {
                    actionSet.appendChild(stanza.createElement(NS, value.toLowerCase(), NS));
                });
            }
        }
    }
});


stanza.add(ErrorStanza, 'adhocCommandCondition', util.enumSub(NS, CONDITIONS));

stanza.extend(Iq, Command);
stanza.extend(Command, DataForm);

},{"./dataforms":55,"./error":58,"./iq":66,"./util":98,"jxt":204}],55:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Message = _dereq_('./message');
var JID = _dereq_('xmpp-jid').JID;

var FORM_NS = 'jabber:x:data';
var MEDIA_NS = 'urn:xmpp:media-element';
var VALIDATE_NS = 'http://jabber.org/protocol/xdata-validate';

var SINGLE_FIELDS = [
    'text-single',
    'text-private',
    'list-single',
    'jid-single'
];


exports.Field = stanza.define({
    name: '_field',
    namespace: FORM_NS,
    element: 'field',
    init: function (data) {
        this._type = (data || {}).type || this.type;
    },
    fields: {
        type: {
            get: function () {
                return stanza.getAttribute(this.xml, 'type', 'text-single');
            },
            set: function (value) {
                this._type = value;
                stanza.setAttribute(this.xml, 'type', value);
            }
        },
        name: stanza.attribute('var'),
        desc: stanza.subText(FORM_NS, 'desc'),
        required: stanza.boolSub(FORM_NS, 'required'),
        label: stanza.attribute('label'),
        value: {
            get: function () {
                var vals = stanza.getMultiSubText(this.xml, FORM_NS, 'value');
                if (this._type === 'boolean') {
                    return vals[0] === '1' || vals[0] === 'true';
                }
                if (vals.length > 1) {
                    if (this._type === 'text-multi') {
                        return vals.join('\n');
                    }

                    if (this._type === 'jid-multi') {
                        return vals.map(function (jid) {
                            return new JID(jid);
                        });
                    }

                    return vals;
                }
                if (SINGLE_FIELDS.indexOf(this._type) >= 0) {
                    if (this._type === 'jid-single') {
                        return new JID(vals[0]);
                    }
                    return vals[0];
                }

                return vals;
            },
            set: function (value) {
                if (this._type === 'boolean') {
                    var truthy = value === true || value === 'true' || value === '1';
                    stanza.setSubText(this.xml, FORM_NS, 'value', truthy ? '1' : '0');
                } else {
                    if (this._type === 'text-multi' && typeof(value) === 'string') {
                        value = value.split('\n');
                    }
                    stanza.setMultiSubText(this.xml, FORM_NS, 'value', value);
                }
            }
        }
    }
});

exports.Option = stanza.define({
    name: '_formoption',
    namespace: FORM_NS,
    element: 'option',
    fields: {
        label: stanza.attribute('label'),
        value: stanza.subText(FORM_NS, 'value')
    }
});

exports.Item = stanza.define({
    name: '_formitem',
    namespace: FORM_NS,
    element: 'item'
});

exports.Media = stanza.define({
    name: 'media',
    element: 'media',
    namespace: MEDIA_NS,
    fields: {
        height: stanza.numberAttribute('height'),
        width: stanza.numberAttribute('width')
    }
});

exports.MediaURI = stanza.define({
    name: '_mediaURI',
    element: 'uri',
    namespace: MEDIA_NS,
    fields: {
        uri: stanza.text(),
        type: stanza.attribute('type')
    }
});

exports.Validation = stanza.define({
    name: 'validation',
    element: 'validate',
    namespace: VALIDATE_NS,
    fields: {
        dataType: stanza.attribute('datatype'),
        basic: stanza.boolSub(VALIDATE_NS, 'basic'),
        open: stanza.boolSub(VALIDATE_NS, 'open'),
        regex: stanza.subText(VALIDATE_NS, 'regex')
    }
});

exports.Range = stanza.define({
    name: 'range',
    element: 'range',
    namespace: VALIDATE_NS,
    fields: {
        min: stanza.attribute('min'),
        max: stanza.attribute('max')
    }
});

exports.ListRange = stanza.define({
    name: 'select',
    element: 'list-range',
    namespace: VALIDATE_NS,
    fields: {
        min: stanza.numberAttribute('min'),
        max: stanza.numberAttribute('max')
    }
});

exports.DataForm = stanza.define({
    name: 'form',
    namespace: FORM_NS,
    element: 'x',
    init: function () {
        // Propagate reported field types to items

        if (!this.reportedFields.length) {
            return;
        }

        var fieldTypes = {};
        this.reportedFields.forEach(function (reported) {
            fieldTypes[reported.name] = reported.type;
        });

        this.items.forEach(function (item) {
            item.fields.forEach(function (field) {
                field.type = field._type = fieldTypes[field.name];
            });
        });
    },
    fields: {
        title: stanza.subText(FORM_NS, 'title'),
        instructions: stanza.multiSubText(FORM_NS, 'instructions'),
        type: stanza.attribute('type', 'form'),
        reportedFields: util.subMultiExtension(FORM_NS, 'reported', exports.Field)
    }
});


stanza.extend(Message, exports.DataForm);
stanza.extend(exports.DataForm, exports.Field, 'fields');
stanza.extend(exports.DataForm, exports.Item, 'items');

stanza.extend(exports.Field, exports.Media);
stanza.extend(exports.Field, exports.Validation);
stanza.extend(exports.Field, exports.Option, 'options');

stanza.extend(exports.Item, exports.Field, 'fields');

stanza.extend(exports.Media, exports.MediaURI, 'uris');
stanza.extend(exports.Validation, exports.Range);
stanza.extend(exports.Validation, exports.ListRange);

},{"./message":71,"./util":98,"jxt":204,"xmpp-jid":225}],56:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var util = _dereq_('./util');

var DelayedDelivery = module.exports = stanza.define({
    name: 'delay',
    namespace: 'urn:xmpp:delay',
    element: 'delay',
    fields: {
        from: util.jidAttribute('from'),
        stamp: stanza.dateAttribute('stamp'),
        reason: stanza.text()
    }
});

stanza.extend(Message, DelayedDelivery);
stanza.extend(Presence, DelayedDelivery);

},{"./message":71,"./presence":77,"./util":98,"jxt":204}],57:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Iq = _dereq_('./iq');
var RSM = _dereq_('./rsm');
var DataForm = _dereq_('./dataforms').DataForm;


var NSInfo = 'http://jabber.org/protocol/disco#info';
var NSItems = 'http://jabber.org/protocol/disco#items';



exports.DiscoInfo = stanza.define({
    name: 'discoInfo',
    namespace: NSInfo,
    element: 'query',
    fields: {
        node: stanza.attribute('node'),
        features: stanza.multiSubAttribute(NSInfo, 'feature', 'var')
    }
});


var DiscoIdentity = stanza.define({
    name: '_discoIdentity',
    namespace: NSInfo,
    element: 'identity',
    fields: {
        category: stanza.attribute('category'),
        type: stanza.attribute('type'),
        name: stanza.attribute('name'),
        lang: stanza.langAttribute()
    }
});


exports.DiscoItems = stanza.define({
    name: 'discoItems',
    namespace: NSItems,
    element: 'query',
    fields: {
        node: stanza.attribute('node'),
    }
});

var DiscoItem = stanza.define({
    name: '_discoItem',
    namespace: NSItems,
    element: 'item',
    fields: {
        jid: util.jidAttribute('jid'),
        node: stanza.attribute('node'),
        name: stanza.attribute('name')
    }
});


stanza.extend(Iq, exports.DiscoInfo);
stanza.extend(Iq, exports.DiscoItems);
stanza.extend(exports.DiscoItems, RSM);
stanza.extend(exports.DiscoItems, DiscoItem, 'items');
stanza.extend(exports.DiscoInfo, DiscoIdentity, 'identities');
stanza.extend(exports.DiscoInfo, DataForm, 'extensions');

},{"./dataforms":55,"./iq":66,"./rsm":87,"./util":98,"jxt":204}],58:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');


var ERR_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
var CONDITIONS = [
    'bad-request', 'conflict', 'feature-not-implemented',
    'forbidden', 'gone', 'internal-server-error',
    'item-not-found', 'jid-malformed', 'not-acceptable',
    'not-allowed', 'not-authorized', 'payment-required',
    'recipient-unavailable', 'redirect',
    'registration-required', 'remote-server-not-found',
    'remote-server-timeout', 'resource-constraint',
    'service-unavailable', 'subscription-required',
    'undefined-condition', 'unexpected-request'
];


var ErrorStanza = module.exports = stanza.define({
    name: 'error',
    namespace: 'jabber:client',
    element: 'error',
    fields: {
        lang: {
            get: function () {
                return (this.parent || {}).lang || '';
            }
        },
        condition: util.enumSub(ERR_NS, CONDITIONS),
        gone: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'gone');
            },
            set: function (value) {
                this.condition = 'gone';
                stanza.setSubText(this.xml, ERR_NS, 'gone', value);
            }
        },
        redirect: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'redirect');
            },
            set: function (value) {
                this.condition = 'redirect';
                stanza.setSubText(this.xml, ERR_NS, 'redirect', value);
            }
        },
        code: stanza.attribute('code'),
        type: stanza.attribute('type'),
        by: util.jidAttribute('by'),
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, ERR_NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, ERR_NS, 'text', value, this.lang);
            }
        }
    }
});


stanza.extend(Message, ErrorStanza);
stanza.extend(Presence, ErrorStanza);
stanza.extend(Iq, ErrorStanza);

},{"./iq":66,"./message":71,"./presence":77,"./util":98,"jxt":204}],59:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;

var NS = 'urn:xmpp:extdisco:1';


var Services = exports.Services = stanza.define({
    name: 'services',
    namespace: NS,
    element: 'services',
    fields: {
        type: stanza.attribute('type')
    }
});

var Credentials = exports.Credentials = stanza.define({
    name: 'credentials',
    namespace: NS,
    element: 'credentials'
});

var Service = stanza.define({
    name: 'service',
    namespace: NS,
    element: 'service',
    fields: {
        host: stanza.attribute('host'),
        port: stanza.attribute('port'),
        transport: stanza.attribute('transport'),
        type: stanza.attribute('type'),
        username: stanza.attribute('username'),
        password: stanza.attribute('password')
    }
});


stanza.extend(Services, Service, 'services');
stanza.extend(Credentials, Service);
stanza.extend(Service, DataForm);

stanza.extend(Iq, Services);
stanza.extend(Iq, Credentials);

},{"./dataforms":55,"./iq":66,"jxt":204}],60:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var jingle = _dereq_('./jingle');
var Hash = _dereq_('./hash');


var NS = 'urn:xmpp:jingle:apps:file-transfer:3';
var TB_NS = 'urn:xmpp:thumbs:0';


exports.File = stanza.define({
    name: '_file',
    namespace: NS,
    element: 'file',
    fields: {
        name: stanza.subText(NS, 'name'),
        desc: stanza.subText(NS, 'desc'),
        size: stanza.numberSub(NS, 'size'),
        date: stanza.dateSub(NS, 'date')
    }
});

exports.Range = stanza.define({
    name: 'range',
    namespace: NS,
    element: 'range',
    fields: {
        offset: stanza.numberAttribute('offset')
    }
});

exports.Thumbnail = stanza.define({
    name: 'thumbnail',
    namespace: TB_NS,
    element: 'thumbnail',
    fields: {
        cid: stanza.attribute('cid'),
        mimeType: stanza.attribute('mime-type'),
        width: stanza.numberAttribute('width'),
        height: stanza.numberAttribute('height')
    }
});

exports.FileTransfer = stanza.define({
    name: '_filetransfer',
    namespace: NS,
    element: 'description',
    fields: {
        descType: {value: 'filetransfer'},
        offer: util.subExtension('offer', NS, 'offer', exports.File),
        request: util.subExtension('request', NS, 'request', exports.File)
    }
});


jingle.registerDescription(exports.FileTransfer);

stanza.extend(exports.File, Hash, 'hashes');
stanza.extend(exports.File, exports.Range);
stanza.extend(exports.File, exports.Thumbnail);
stanza.extend(jingle.Content, exports.FileTransfer);

},{"./hash":64,"./jingle":67,"./util":98,"jxt":204}],61:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');
var DelayedDelivery = _dereq_('./delayed');


var Forwarded = module.exports = stanza.define({
    name: 'forwarded',
    eventName: 'forward',
    namespace: 'urn:xmpp:forward:0',
    element: 'forwarded'
});


stanza.extend(Message, Forwarded);
stanza.extend(Forwarded, Message);
stanza.extend(Forwarded, Presence);
stanza.extend(Forwarded, Iq);
stanza.extend(Forwarded, DelayedDelivery);

},{"./delayed":56,"./iq":66,"./message":71,"./presence":77,"jxt":204}],62:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');

var NS = 'urn:ietf:params:xml:ns:xmpp-framing';


exports.Open = stanza.define({
    name: 'openStream',
    namespace: NS,
    element: 'open',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        version: stanza.attribute('version', '1.0'),
        to: util.jidAttribute('to', true),
        from: util.jidAttribute('from', true)
    }
});

exports.Close = stanza.define({
    name: 'closeStream',
    namespace: NS,
    element: 'close',
    topLevel: true,
    fields: {
        seeOtherURI: stanza.attribute('see-other-uri')
    }
});

},{"./util":98,"jxt":204}],63:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;

var NS = 'http://jabber.org/protocol/geoloc';

var GeoLoc = module.exports = stanza.define({
    name: 'geoloc',
    namespace: NS,
    element: 'geoloc',
    fields: {
        accuracy: stanza.numberSub(NS, 'accuracy', true),
        altitude: stanza.numberSub(NS, 'alt', true),
        area: stanza.subText(NS, 'area'),
        heading: stanza.numberSub(NS, 'bearing', true),
        bearing: stanza.numberSub(NS, 'bearing', true),
        building: stanza.subText(NS, 'building'),
        country: stanza.subText(NS, 'country'),
        countrycode: stanza.subText(NS, 'countrycode'),
        datum: stanza.subText(NS, 'datum'),
        description: stanza.subText(NS, 'description'),
        error: stanza.numberSub(NS, 'error', true),
        floor: stanza.subText(NS, 'floor'),
        latitude: stanza.numberSub(NS, 'lat', true),
        locality: stanza.subText(NS, 'locality'),
        longitude: stanza.numberSub(NS, 'lon', true),
        postalcode: stanza.subText(NS, 'postalcode'),
        region: stanza.subText(NS, 'region'),
        room: stanza.subText(NS, 'room'),
        speed: stanza.numberSub(NS, 'speed', true),
        street: stanza.subText(NS, 'street'),
        text: stanza.subText(NS, 'text'),
        timestamp: stanza.dateSub(NS, 'timestamp'),
        tzo: util.tzoSub(NS, 'tzo'),
        uri: stanza.subText(NS, 'uri')
    }
});

stanza.extend(Item, GeoLoc);
stanza.extend(EventItem, GeoLoc);

},{"./pubsub":80,"./pubsubEvents":82,"./util":98,"jxt":204}],64:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

module.exports = stanza.define({
    name: 'hash',
    namespace: 'urn:xmpp:hashes:1',
    element: 'hash',
    fields: {
        algo: stanza.attribute('algo'),
        value: stanza.text()
    }
});

},{"jxt":204}],65:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var jingle = _dereq_('./jingle');


var NS = 'urn:xmpp:jingle:transports:ice-udp:1';


exports.ICEUDP = stanza.define({
    name: '_iceUdp',
    namespace: NS,
    element: 'transport',
    fields: {
        transType: {value: 'iceUdp'},
        pwd: stanza.attribute('pwd'),
        ufrag: stanza.attribute('ufrag')
    }
});


exports.RemoteCandidate = stanza.define({
    name: 'remoteCandidate',
    namespace: NS,
    element: 'remote-candidate',
    fields: {
        component: stanza.attribute('component'),
        ip: stanza.attribute('ip'),
        port: stanza.attribute('port')
    }
});


exports.Candidate = stanza.define({
    name: '_iceUdpCandidate',
    namespace: NS,
    element: 'candidate',
    fields: {
        component: stanza.attribute('component'),
        foundation: stanza.attribute('foundation'),
        generation: stanza.attribute('generation'),
        id: stanza.attribute('id'),
        ip: stanza.attribute('ip'),
        network: stanza.attribute('network'),
        port: stanza.attribute('port'),
        priority: stanza.attribute('priority'),
        protocol: stanza.attribute('protocol'),
        relAddr: stanza.attribute('rel-addr'),
        relPort: stanza.attribute('rel-port'),
        type: stanza.attribute('type')
    }
});


exports.Fingerprint = stanza.define({
    name: '_iceFingerprint',
    namespace: 'urn:xmpp:jingle:apps:dtls:0',
    element: 'fingerprint',
    fields: {
        hash: stanza.attribute('hash'),
        setup: stanza.attribute('setup'),
        value: stanza.text(),
        required: stanza.boolAttribute('required')
    }
});

exports.SctpMap = stanza.define({
    name: '_sctpMap',
    namespace: 'urn:xmpp:jingle:transports:dtls-sctp:1',
    element: 'sctpmap',
    fields: {
        number: stanza.attribute('number'),
        protocol: stanza.attribute('protocol'),
        streams: stanza.attribute('streams')
    }
});

jingle.registerTransport(exports.ICEUDP);

stanza.extend(jingle.Content, exports.ICEUDP);
stanza.extend(exports.ICEUDP, exports.Candidate, 'candidates');
stanza.extend(exports.ICEUDP, exports.RemoteCandidate);
stanza.extend(exports.ICEUDP, exports.Fingerprint, 'fingerprints');
stanza.extend(exports.ICEUDP, exports.SctpMap, 'sctp');

},{"./jingle":67,"jxt":204}],66:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');


var Iq = module.exports = stanza.define({
    name: 'iq',
    namespace: 'jabber:client',
    element: 'iq',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: util.jidAttribute('to', true),
        from: util.jidAttribute('from', true),
        type: stanza.attribute('type')
    }
});

var toJSON = Iq.prototype.toJSON;

Iq.prototype.toJSON = function () {
    var result = toJSON.call(this);
    result.resultReply = this.resultReply;
    result.errorReply = this.errorReply;
    return result;
};

Iq.prototype.resultReply = function (data) {
    data = data || {};
    data.to = this.from;
    data.id = this.id;
    data.type = 'result';
    return new Iq(data);
};

Iq.prototype.errorReply = function (data) {
    data = data || {};
    data.to = this.from;
    data.id = this.id;
    data.type = 'error';
    return new Iq(data);
};

},{"./util":98,"jxt":204}],67:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Iq = _dereq_('./iq');
var ErrorStanza = _dereq_('./error');


var NS = 'urn:xmpp:jingle:1';
var ERRNS = 'urn:xmpp:jingle:errors:1';
var CONDITIONS = ['out-of-order', 'tie-break', 'unknown-session', 'unsupported-info'];
var REASONS = [
    'alternative-session', 'busy', 'cancel', 'connectivity-error',
    'decline', 'expired', 'failed-application', 'failed-transport',
    'general-error', 'gone', 'incompatible-parameters', 'media-error',
    'security-error', 'success', 'timeout', 'unsupported-applications',
    'unsupported-transports'
];


var REGISTRY = {
    descriptions: [],
    transports: []
};


exports.registerDescription = function (desc) {
    REGISTRY.descriptions.push(desc.prototype._name);
};

exports.registerTransport = function (trans) {
    REGISTRY.transports.push(trans.prototype._name);
};


exports.Jingle = stanza.define({
    name: 'jingle',
    namespace: NS,
    element: 'jingle',
    fields: {
        action: stanza.attribute('action'),
        initiator: stanza.attribute('initiator'),
        responder: stanza.attribute('responder'),
        sid: stanza.attribute('sid')
    }
});


exports.Content = stanza.define({
    name: '_jingleContent',
    namespace: NS,
    element: 'content',
    fields: {
        creator: stanza.attribute('creator'),
        disposition: stanza.attribute('disposition', 'session'),
        name: stanza.attribute('name'),
        senders: stanza.attribute('senders', 'both'),
        description: {
            get: function () {
                var opts = REGISTRY.descriptions;
                for (var i = 0, len = opts.length; i < len; i++) {
                    if (this._extensions[opts[i]]) {
                        return this._extensions[opts[i]];
                    }
                }
            },
            set: function (value) {
                var ext = '_' + value.descType;
                this[ext] = value;
            }
        },
        transport: {
            get: function () {
                var opts = REGISTRY.transports;
                for (var i = 0, len = opts.length; i < len; i++) {
                    if (this._extensions[opts[i]]) {
                        return this._extensions[opts[i]];
                    }
                }
            },
            set: function (value) {
                var ext = '_' + value.transType;
                this[ext] = value;
            }
        }
    }
});

exports.Reason = stanza.define({
    name: 'reason',
    namespace: NS,
    element: 'reason',
    fields: {
        condition: util.enumSub(NS, REASONS),
        alternativeSession: {
            get: function () {
                return stanza.getSubText(this.xml, NS, 'alternative-session');
            },
            set: function (value) {
                this.condition = 'alternative-session';
                stanza.setSubText(this.xml, NS, 'alternative-session', value);
            }
        },
        text: stanza.subText(NS, 'text')
    }
});


stanza.add(ErrorStanza, 'jingleCondition', util.enumSub(ERRNS, CONDITIONS));

stanza.extend(Iq, exports.Jingle);
stanza.extend(exports.Jingle, exports.Content, 'contents');
stanza.extend(exports.Jingle, exports.Reason);

},{"./error":58,"./iq":66,"./util":98,"jxt":204}],68:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;


var JSONExtension = module.exports = {
    get: function () {
        var data = stanza.getSubText(this.xml, 'urn:xmpp:json:0', 'json');
        if (data) {
            return JSON.parse(data);
        }
    },
    set: function (value) {
        value = JSON.stringify(value);
        if (value) {
            stanza.setSubText(this.xml, 'urn:xmpp:json:0', 'json', value);
        }
    }
};


stanza.add(Message, 'json', JSONExtension);
stanza.add(Item, 'json', JSONExtension);
stanza.add(EventItem, 'json', JSONExtension);

},{"./message":71,"./pubsub":80,"./pubsubEvents":82,"jxt":204}],69:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');

var NS = 'urn:xmpp:eventlog';


exports.Log = stanza.define({
    name: 'log',
    namespace: NS,
    element: 'log',
    fields: {
        id: stanza.attribute('id'),
        timestamp: stanza.dateAttribute('timestamp'),
        type: stanza.attribute('type'),
        level: stanza.attribute('level'),
        object: stanza.attribute('object'),
        subject: stanza.attribute('subject'),
        facility: stanza.attribute('facility'),
        module: stanza.attribute('module'),
        message: stanza.subText(NS, 'message'),
        stackTrace: stanza.subText(NS, 'stackTrace')
    }
});

exports.Tag = stanza.define({
    name: '_logtag',
    namespace: NS,
    element: 'tag',
    fields: {
        name: stanza.attribute('name'),
        value: stanza.attribute('value'),
        type: stanza.attribute('type')
    }
});


stanza.extend(exports.Log, exports.Tag, 'tags');
stanza.extend(Message, exports.Log);

},{"./message":71,"jxt":204}],70:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Message = _dereq_('./message');
var Iq = _dereq_('./iq');
var Forwarded = _dereq_('./forwarded');
var RSM = _dereq_('./rsm');
var JID = _dereq_('xmpp-jid').JID;


exports.MAMQuery = stanza.define({
    name: 'mamQuery',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'query',
    fields: {
        queryid: stanza.attribute('queryid'),
        start: stanza.dateSub('urn:xmpp:mam:tmp', 'start'),
        end: stanza.dateSub('urn:xmpp:mam:tmp', 'end'),
        'with': util.jidSub('urn:xmpp:mam:tmp', 'with')
    }
});

exports.Result = stanza.define({
    name: 'mam',
    eventName: 'mam:result',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'result',
    fields: {
        queryid: stanza.attribute('queryid'),
        id: stanza.attribute('id')
    }
});

exports.Archived = stanza.define({
    name: '_mamArchived',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'archived',
    fields: {
        by: util.jidAttribute('by'),
        id: stanza.attribute('id')
    }
});

exports.Prefs = stanza.define({
    name: 'mamPrefs',
    namespace: 'urn:xmpp:mam:tmp',
    element: 'prefs',
    fields: {
        defaultCondition: stanza.attribute('default'),
        always: {
            get: function () {
                var results = [];
                var container = stanza.find(this.xml, this._NS, 'always');
                if (container.length === 0) {
                    return results;
                }
                container = container[0];
                var jids = stanza.getMultiSubText(container, this._NS, 'jid');
                jids.forEach(function (jid) {
                    results.push(new JID(jid.textContent));
                });
                return results;
            },
            set: function (value) {
                if (value.length > 0) {
                    var container = stanza.find(this.xml, this._NS, 'always');
                    stanza.setMultiSubText(container, this._NS, 'jid', value);
                }
            }
        },
        never: {
            get: function () {
                var results = [];
                var container = stanza.find(this.xml, this._NS, 'always');
                if (container.length === 0) {
                    return results;
                }
                container = container[0];
                var jids = stanza.getMultiSubText(container, this._NS, 'jid');
                jids.forEach(function (jid) {
                    results.push(new JID(jid.textContent));
                });
                return results;
            },
            set: function (value) {
                if (value.length > 0) {
                    var container = stanza.find(this.xml, this._NS, 'never');
                    stanza.setMultiSubText(container, this._NS, 'jid', value);
                }
            }
        }
    }
});

stanza.extend(Message, exports.Archived, 'archived');
stanza.extend(Iq, exports.MAMQuery);
stanza.extend(Iq, exports.Prefs);
stanza.extend(Message, exports.Result);
stanza.extend(exports.Result, Forwarded);
stanza.extend(exports.MAMQuery, RSM);

},{"./forwarded":61,"./iq":66,"./message":71,"./rsm":87,"./util":98,"jxt":204,"xmpp-jid":225}],71:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');


module.exports = stanza.define({
    name: 'message',
    namespace: 'jabber:client',
    element: 'message',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: util.jidAttribute('to', true),
        from: util.jidAttribute('from', true),
        type: stanza.attribute('type', 'normal'),
        thread: stanza.subText('jabber:client', 'thread'),
        parentThread: stanza.subAttribute('jabber:client', 'thread', 'parent'),
        subject: stanza.subText('jabber:client', 'subject'),
        $body: {
            get: function () {
                return stanza.getSubLangText(this.xml, this._NS, 'body', this.lang);
            }
        },
        body: {
            get: function () {
                var bodies = this.$body;
                return bodies[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, this._NS, 'body', value, this.lang);
            }
        },
        attention: stanza.boolSub('urn:xmpp:attention:0', 'attention'),
        chatState: util.enumSub('http://jabber.org/protocol/chatstates', [
            'active', 'composing', 'paused', 'inactive', 'gone'
        ]),
        replace: stanza.subAttribute('urn:xmpp:message-correct:0', 'replace', 'id'),
        requestReceipt: stanza.boolSub('urn:xmpp:receipts', 'request'),
        receipt: stanza.subAttribute('urn:xmpp:receipts', 'received', 'id')
    }
});

},{"./util":98,"jxt":204}],72:[function(_dereq_,module,exports){
'use strict';
var stanza = _dereq_('jxt');
var util = _dereq_('./util');

var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Message = _dereq_('./message');


var NS = 'http://jabber.org/protocol/mood';

var MOODS = [
    'afraid',
    'amazed',
    'amorous',
    'angry',
    'annoyed',
    'anxious',
    'aroused',
    'ashamed',
    'bored',
    'brave',
    'calm',
    'cautious',
    'cold',
    'confident',
    'confused',
    'contemplative',
    'contented',
    'cranky',
    'crazy',
    'creative',
    'curious',
    'dejected',
    'depressed',
    'disappointed',
    'disgusted',
    'dismayed',
    'distracted',
    'embarrassed',
    'envious',
    'excited',
    'flirtatious',
    'frustrated',
    'grateful',
    'grieving',
    'grumpy',
    'guilty',
    'happy',
    'hopeful',
    'hot',
    'humbled',
    'humiliated',
    'hungry',
    'hurt',
    'impressed',
    'in_awe',
    'in_love',
    'indignant',
    'interested',
    'intoxicated',
    'invincible',
    'jealous',
    'lonely',
    'lucky',
    'mean',
    'moody',
    'nervous',
    'neutral',
    'offended',
    'outraged',
    'playful',
    'proud',
    'relaxed',
    'relieved',
    'remorseful',
    'restless',
    'sad',
    'sarcastic',
    'serious',
    'shocked',
    'shy',
    'sick',
    'sleepy',
    'spontaneous',
    'stressed',
    'strong',
    'surprised',
    'thankful',
    'thirsty',
    'tired',
    'undefined',
    'weak',
    'worried'
];


var Mood = module.exports = stanza.define({
    name: 'mood',
    namespace: NS,
    element: 'mood',
    fields: {
        text: stanza.subText(NS, 'text'),
        value: util.enumSub(NS, MOODS)
    }
});


stanza.extend(Item, Mood);
stanza.extend(EventItem, Mood);
stanza.extend(Message, Mood);

},{"./message":71,"./pubsub":80,"./pubsubEvents":82,"./util":98,"jxt":204}],73:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var util = _dereq_('./util');

var NS = 'http://jabber.org/protocol/muc';
var USER_NS = NS + '#user';
var ADMIN_NS = NS + '#admin';
var OWNER_NS = NS + '#owner';
var UNIQ_NS = NS + '#unique';


var proxy = function (child, field) {
    return {
        get: function () {
            if (this._extensions[child]) {
                return this[child][field];
            }
        },
        set: function (value) {
            this[child][field] = value;
        }
    };
};

var UserItem = stanza.define({
    name: '_mucUserItem',
    namespace: USER_NS,
    element: 'item',
    fields: {
        affiliation: stanza.attribute('affiliation'),
        nick: stanza.attribute('nick'),
        jid: util.jidAttribute('jid'),
        role: stanza.attribute('role'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var UserActor = stanza.define({
    name: '_mucUserActor',
    namespace: USER_NS,
    element: 'actor',
    fields: {
        nick: stanza.attribute('nick'),
        jid: util.jidAttribute('jid')
    }
});

var Destroyed = stanza.define({
    name: 'destroyed',
    namespace: USER_NS,
    element: 'destroy',
    fields: {
        jid: util.jidAttribute('jid'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var Invite = stanza.define({
    name: 'invite',
    namespace: USER_NS,
    element: 'invite',
    fields: {
        to: util.jidAttribute('to'),
        from: util.jidAttribute('from'),
        reason: stanza.subText(USER_NS, 'reason'),
        thread: stanza.subAttribute(USER_NS, 'continue', 'thread'),
        'continue': stanza.boolSub(USER_NS, 'continue')
    }
});

var Decline = stanza.define({
    name: 'decline',
    namespace: USER_NS,
    element: 'decline',
    fields: {
        to: util.jidAttribute('to'),
        from: util.jidAttribute('from'),
        reason: stanza.subText(USER_NS, 'reason')
    }
});

var AdminItem = stanza.define({
    name: '_mucAdminItem',
    namespace: ADMIN_NS,
    element: 'item',
    fields: {
        affiliation: stanza.attribute('affiliation'),
        nick: stanza.attribute('nick'),
        jid: util.jidAttribute('jid'),
        role: stanza.attribute('role'),
        reason: stanza.subText(ADMIN_NS, 'reason')
    }
});

var AdminActor = stanza.define({
    name: 'actor',
    namespace: USER_NS,
    element: 'actor',
    fields: {
        nick: stanza.attribute('nick'),
        jid: util.jidAttribute('jid')
    }
});

var Destroy = stanza.define({
    name: 'destroy',
    namespace: OWNER_NS,
    element: 'destroy',
    fields: {
        jid: util.jidAttribute('jid'),
        password: stanza.subText(OWNER_NS, 'password'),
        reason: stanza.subText(OWNER_NS, 'reason')
    }
});

exports.MUC = stanza.define({
    name: 'muc',
    namespace: USER_NS,
    element: 'x',
    fields: {
        affiliation: proxy('_mucUserItem', 'affiliation'),
        nick: proxy('_mucUserItem', 'nick'),
        jid: proxy('_mucUserItem', 'jid'),
        role: proxy('_mucUserItem', 'role'),
        actor: proxy('_mucUserItem', '_mucUserActor'),
        reason: proxy('_mucUserItem', 'reason'),
        password: stanza.subText(USER_NS, 'password'),
        codes: {
            get: function () {
                return stanza.getMultiSubText(this.xml, USER_NS, 'status', function (sub) {
                    return stanza.getAttribute(sub, 'code');
                });
            },
            set: function (value) {
                var self = this;
                stanza.setMultiSubText(this.xml, USER_NS, 'status', value, function (val) {
                    var child = stanza.createElement(USER_NS, 'status', USER_NS);
                    stanza.setAttribute(child, 'code', val);
                    self.xml.appendChild(child);
                });
            }
        }
    }
});

exports.MUCAdmin = stanza.define({
    name: 'mucAdmin',
    namespace: ADMIN_NS,
    element: 'query',
    fields: {
        affiliation: proxy('_mucAdminItem', 'affiliation'),
        nick: proxy('_mucAdminItem', 'nick'),
        jid: proxy('_mucAdminItem', 'jid'),
        role: proxy('_mucAdminItem', 'role'),
        actor: proxy('_mucAdminItem', '_mucAdminActor'),
        reason: proxy('_mucAdminItem', 'reason')
    }
});

exports.MUCOwner = stanza.define({
    name: 'mucOwner',
    namespace: OWNER_NS,
    element: 'query'
});

exports.MUCJoin = stanza.define({
    name: 'joinMuc',
    namespace: NS,
    element: 'x',
    fields: {
        password: stanza.subText(NS, 'password'),
        history: {
            get: function () {
                var result = {};
                var hist = stanza.find(this.xml, this._NS, 'history');

                if (!hist.length) {
                    return {};
                }
                hist = hist[0];

                var maxchars = hist.getAttribute('maxchars') || '';
                var maxstanzas = hist.getAttribute('maxstanas') || '';
                var seconds = hist.getAttribute('seconds') || '';
                var since = hist.getAttribute('since') || '';


                if (maxchars) {
                    result.maxchars = parseInt(maxchars, 10);
                }
                if (maxstanzas) {
                    result.maxstanzas = parseInt(maxstanzas, 10);
                }
                if (seconds) {
                    result.seconds = parseInt(seconds, 10);
                }
                if (since) {
                    result.since = new Date(since);
                }
            },
            set: function (opts) {
                var existing = stanza.find(this.xml, this._NS, 'history');
                if (existing.length) {
                    for (var i = 0; i < existing.length; i++) {
                        this.xml.removeChild(existing[i]);
                    }
                }

                var hist = stanza.createElement(this._NS, 'history', this._NS);
                this.xml.appendChild(hist);

                if (opts.maxchars) {
                    hist.setAttribute('' + opts.maxchars);
                }
                if (opts.maxstanzas) {
                    hist.setAttribute('' + opts.maxstanzas);
                }
                if (opts.seconds) {
                    hist.setAttribute('' + opts.seconds);
                }
                if (opts.since) {
                    hist.setAttribute(opts.since.toISOString());
                }
            }
        }
    }
});

exports.DirectInvite = stanza.define({
    name: 'mucInvite',
    namespace: 'jabber:x:conference',
    element: 'x',
    fields: {
        jid: util.jidAttribute('jid'),
        password: stanza.attribute('password'),
        reason: stanza.attribute('reason'),
        thread: stanza.attribute('thread'),
        'continue': stanza.boolAttribute('continue')
    }
});


stanza.add(Iq, 'mucUnique', stanza.subText(UNIQ_NS, 'unique'));


stanza.extend(UserItem, UserActor);
stanza.extend(exports.MUC, UserItem);
stanza.extend(exports.MUC, Invite, 'invites');
stanza.extend(exports.MUC, Decline);
stanza.extend(exports.MUC, Destroyed);
stanza.extend(AdminItem, AdminActor);
stanza.extend(exports.MUCAdmin, AdminItem, 'items');
stanza.extend(exports.MUCOwner, Destroy);
stanza.extend(exports.MUCOwner, DataForm);
stanza.extend(Presence, exports.MUC);
stanza.extend(Message, exports.MUC);
stanza.extend(Presence, exports.MUCJoin);
stanza.extend(Message, exports.DirectInvite);
stanza.extend(Iq, exports.MUCAdmin);
stanza.extend(Iq, exports.MUCOwner);

},{"./dataforms":55,"./iq":66,"./message":71,"./presence":77,"./util":98,"jxt":204}],74:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Presence = _dereq_('./presence');
var Message = _dereq_('./message');


var nick = stanza.subText('http://jabber.org/protocol/nick', 'nick');


stanza.add(Item, 'nick', nick);
stanza.add(EventItem, 'nick', nick);
stanza.add(Presence, 'nick', nick);
stanza.add(Message, 'nick', nick);

},{"./message":71,"./presence":77,"./pubsub":80,"./pubsubEvents":82,"jxt":204}],75:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var NS = 'jabber:x:oob';

var OOB = module.exports = stanza.define({
    name: 'oob',
    element: 'x',
    namespace: NS,
    fields: {
        url: stanza.subText(NS, 'url'),
        desc: stanza.subText(NS, 'desc')
    }
});

stanza.extend(Message, OOB, 'oobURIs');

},{"./message":71,"jxt":204}],76:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');

var NS = 'urn:xmpp:ping';

var Ping = module.exports = stanza.define({
    name: 'ping',
    namespace: NS,
    element: 'ping',
    fields: {
    }
});

stanza.extend(Iq, Ping);

},{"./iq":66,"jxt":204}],77:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');


module.exports = stanza.define({
    name: 'presence',
    namespace: 'jabber:client',
    element: 'presence',
    topLevel: true,
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        to: util.jidAttribute('to', true),
        from: util.jidAttribute('from', true),
        priority: stanza.numberSub('jabber:client', 'priority', false, 0),
        show: stanza.subText('jabber:client', 'show'),
        type: {
            get: function () {
                return stanza.getAttribute(this.xml, 'type', 'available');
            },
            set: function (value) {
                if (value === 'available') {
                    value = false;
                }
                stanza.setAttribute(this.xml, 'type', value);
            }
        },
        $status: {
            get: function () {
                return stanza.getSubLangText(this.xml, this._NS, 'status', this.lang);
            }
        },
        status: {
            get: function () {
                var statuses = this.$status;
                return statuses[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, this._NS, 'status', value, this.lang);
            }
        },
        idleSince: stanza.dateSubAttribute('urn:xmpp:idle:1', 'idle', 'since'),
        decloak: stanza.subAttribute('urn:xmpp:decloak:0', 'decloak', 'reason'),
        avatarId: {
            get: function () {
                var NS = 'vcard-temp:x:update';
                var update = stanza.find(this.xml, NS, 'x');
                if (!update.length) {
                    return '';
                }
                return stanza.getSubText(update[0], NS, 'photo');
            },
            set: function (value) {
                var NS = 'vcard-temp:x:update';
                var update = stanza.findOrCreate(this.xml, NS, 'x');

                if (value === '') {
                    stanza.setBoolSub(update, NS, 'photo', true);
                } else if (value === true) {
                    return;
                } else if (value) {
                    stanza.setSubText(update, NS, 'photo', value);
                } else {
                    this.xml.removeChild(update);
                }
            }
        }
    }
});

},{"./util":98,"jxt":204}],78:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');


var PrivateStorage = module.exports = stanza.define({
    name: 'privateStorage',
    namespace: 'jabber:iq:private',
    element: 'query'
});

stanza.extend(Iq, PrivateStorage);

},{"./iq":66,"jxt":204}],79:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Presence = _dereq_('./presence');

var NS = 'urn:xmpp:psa';
var CONDITIONS = [
    'server-unavailable', 'connection-paused'
];


var PSA = module.exports = stanza.define({
    name: 'state',
    namespace: NS,
    element: 'state-annotation',
    fields: {
        from: util.jidAttribute('from'),
        condition: util.enumSub(NS, CONDITIONS),
        description: stanza.subText(NS, 'description')
    }
});


stanza.extend(Presence, PSA);

},{"./presence":77,"./util":98,"jxt":204}],80:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var RSM = _dereq_('./rsm');


var NS = 'http://jabber.org/protocol/pubsub';


exports.Pubsub = stanza.define({
    name: 'pubsub',
    namespace: 'http://jabber.org/protocol/pubsub',
    element: 'pubsub',
    fields: {
        publishOptions: {
            get: function () {
                var conf = stanza.find(this.xml, this._NS, 'publish-options');
                if (conf.length && conf[0].childNodes.length) {
                    return new DataForm({}, conf[0].childNodes[0]);
                }
            },
            set: function (value) {
                var conf = stanza.findOrCreate(this.xml, this._NS, 'publish-options');
                if (value) {
                    var form = new DataForm(value);
                    conf.appendChild(form.xml);
                }
            }
        }
    }
});

exports.Subscribe = stanza.define({
    name: 'subscribe',
    namespace: NS,
    element: 'subscribe',
    fields: {
        node: stanza.attribute('node'),
        jid: util.jidAttribute('jid')
    }
});

exports.Subscription = stanza.define({
    name: 'subscription',
    namespace: NS,
    element: 'subscription',
    fields: {
        node: stanza.attribute('node'),
        jid: util.jidAttribute('jid'),
        subid: stanza.attribute('subid'),
        type: stanza.attribute('subscription'),
        configurable: stanza.boolSub('subscribe-options'),
        configurationRequired: {
            get: function () {
                var options = stanza.find(this.xml, NS, 'subscribe-options');
                if (options.length) {
                    return stanza.getBoolSub(options[0], NS, 'required');
                }
                return false;
            }
        }
    }
});

exports.SubscriptionOptions = stanza.define({
    name: 'subscriptionOptions',
    namespace: NS,
    element: 'options',
    fields: {
        node: stanza.attribute('node'),
        jid: util.jidAttribute('jid'),
        subid: stanza.attribute('subid')
    }
});

exports.Unsubscribe = stanza.define({
    name: 'unsubscribe',
    namespace: NS,
    element: 'unsubscribe',
    fields: {
        node: stanza.attribute('node'),
        jid: util.jidAttribute('jid')
    }
});

exports.Publish = stanza.define({
    name: 'publish',
    namespace: NS,
    element: 'publish',
    fields: {
        node: stanza.attribute('node'),
    }
});

exports.Retract = stanza.define({
    name: 'retract',
    namespace: NS,
    element: 'retract',
    fields: {
        node: stanza.attribute('node'),
        notify: stanza.boolAttribute('notify'),
        id: stanza.subAttribute(NS, 'item', 'id')
    }
});

exports.Retrieve = stanza.define({
    name: 'retrieve',
    namespace: NS,
    element: 'items',
    fields: {
        node: stanza.attribute('node'),
        max: stanza.attribute('max_items')
    }
});

exports.Item = stanza.define({
    name: 'item',
    namespace: NS,
    element: 'item',
    fields: {
        id: stanza.attribute('id')
    }
});


stanza.extend(exports.Pubsub, exports.Subscribe);
stanza.extend(exports.Pubsub, exports.Unsubscribe);
stanza.extend(exports.Pubsub, exports.Publish);
stanza.extend(exports.Pubsub, exports.Retrieve);
stanza.extend(exports.Pubsub, exports.Subscription);
stanza.extend(exports.Pubsub, exports.SubscriptionOptions);
stanza.extend(exports.Pubsub, RSM);

stanza.extend(exports.Publish, exports.Item, 'items');
stanza.extend(exports.Retrieve, exports.Item, 'items');

stanza.extend(exports.SubscriptionOptions, DataForm);

stanza.extend(Iq, exports.Pubsub);

},{"./dataforms":55,"./iq":66,"./rsm":87,"./util":98,"jxt":204}],81:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var ErrorStanza = _dereq_('./error');


var ERRNS = 'http://jabber.org/protocol/pubsub#errors';
var CONDITIONS = [
    'closed-node',
    'configuration-required',
    'invalid-jid',
    'invalid-options',
    'invalid-payload',
    'invalid-subid',
    'item-forbidden',
    'item-required',
    'jid-required',
    'max-items-exceeded',
    'max-nodes-exceeded',
    'nodeid-required',
    'not-in-roster-group',
    'not-subscribed',
    'payload-too-big',
    'payload-required',
    'pending-subscription',
    'presence-subscription-required',
    'subid-required',
    'too-many-subscriptions',
    'unsupported',
    'unsupported-access-model'
];


stanza.add(ErrorStanza, 'pubsubCondition', util.enumSub(ERRNS, CONDITIONS));

},{"./error":58,"./util":98,"jxt":204}],82:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Message = _dereq_('./message');
var DataForm = _dereq_('./dataforms').DataForm;


var NS = 'http://jabber.org/protocol/pubsub#event';


exports.Event = stanza.define({
    name: 'event',
    namespace: NS,
    element: 'event'
});

exports.EventPurge = stanza.define({
    name: 'purged',
    namespace: NS,
    element: 'purge',
    fields: {
        node: stanza.attribute('node'),
    }
});

exports.EventDelete = stanza.define({
    name: 'deleted',
    namespace: NS,
    element: 'delete',
    fields: {
        node: stanza.attribute('node'),
        redirect: stanza.subAttribute(NS, 'redirect', 'uri')
    }
});

exports.EventSubscription = stanza.define({
    name: 'subscriptionChanged',
    namespace: NS,
    element: 'subscription',
    fields: {
        node: stanza.attribute('node'),
        jid: util.jidAttribute('jid'),
        type: stanza.attribute('subscription'),
        subid: stanza.attribute('subid'),
        expiry: {
            get: function () {
                var text = stanza.getAttribute(this.xml, 'expiry');
                if (text === 'presence') {
                    return text;
                } else if (text) {
                    return new Date(text);
                }
            },
            set: function (value) {
                if (!value) {
                    return;
                }

                if (typeof value !== 'string') {
                    value = value.toISOString();
                }

                stanza.setAttribute(this.xml, 'expiry', value);
            }
        }
    }
});

exports.EventConfiguration = stanza.define({
    name: 'configurationChanged',
    namespace: NS,
    element: 'configuration',
    fields: {
        node: stanza.attribute('node')
    }
});

exports.EventItems = stanza.define({
    name: 'updated',
    namespace: NS,
    element: 'items',
    fields: {
        node: stanza.attribute('node'),
        retracted: {
            get: function () {
                var results = [];
                var retracted = stanza.find(this.xml, this._NS, 'retract');

                retracted.forEach(function (xml) {
                    results.push(xml.getAttribute('id'));
                });
                return results;
            },
            set: function (value) {
                var self = this;
                value.forEach(function (id) {
                    var retracted = stanza.createElement(self._NS, 'retract', self._NS);
                    retracted.setAttribute('id', id);
                    this.xml.appendChild(retracted);
                });
            }
        }
    }
});

exports.EventItem = stanza.define({
    name: '_eventItem',
    namespace: NS,
    element: 'item',
    fields: {
        id: stanza.attribute('id'),
        node: stanza.attribute('node'),
        publisher: util.jidAttribute('publisher')
    }
});


stanza.extend(exports.EventConfiguration, DataForm);

stanza.extend(exports.EventItems, exports.EventItem, 'published');

stanza.extend(exports.Event, exports.EventItems);
stanza.extend(exports.Event, exports.EventSubscription);
stanza.extend(exports.Event, exports.EventConfiguration);
stanza.extend(exports.Event, exports.EventDelete);
stanza.extend(exports.Event, exports.EventPurge);

stanza.extend(Message, exports.Event);

},{"./dataforms":55,"./message":71,"./util":98,"jxt":204}],83:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;


var NS = 'http://jabber.org/protocol/pubsub#owner';


exports.PubsubOwner = stanza.define({
    name: 'pubsubOwner',
    namespace: NS,
    element: 'pubsub',
    fields: {
        create: stanza.subAttribute(NS, 'create', 'node'),
        purge: stanza.subAttribute(NS, 'purge', 'node'),
        del: stanza.subAttribute(NS, 'delete', 'node'),
        redirect: {
            get: function () {
                var del = stanza.find(this.xml, this._NS, 'delete');
                if (del.length) {
                    return stanza.getSubAttribute(del[0], this._NS, 'redirect', 'uri');
                }
                return '';
            },
            set: function (value) {
                var del = stanza.findOrCreate(this.xml, this._NS, 'delete');
                stanza.setSubAttribute(del, this._NS, 'redirect', 'uri', value);
            }
        }
    }
});

exports.Configure = stanza.define({
    name: 'config',
    namespace: NS,
    element: 'configure',
    fields: {
        node: stanza.attribute('node')
    }
});


stanza.extend(exports.Configure, DataForm);
stanza.extend(exports.PubsubOwner, exports.Configure);

stanza.extend(Iq, exports.PubsubOwner);

},{"./dataforms":55,"./iq":66,"jxt":204}],84:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var stanza = _dereq_('jxt');
var Item = _dereq_('./pubsub').Item;
var EventItem = _dereq_('./pubsubEvents').EventItem;
var Presence = _dereq_('./presence');


var NS = 'urn:xmpp:reach:0';


var ReachURI = module.exports = stanza.define({
    name: '_reachAddr',
    namespace: NS,
    element: 'addr',
    fields: {
        uri: stanza.attribute('uri'),
        $desc: {
            get: function () {
                return stanza.getSubLangText(this.xml, NS, 'desc', this.lang);
            }
        },
        desc: {
            get: function () {
                var descs = this.$desc;
                return descs[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, NS, 'desc', value, this.lang);
            }
        }
    }
});


var reachability = {
    get: function () {
        var reach = stanza.find(this.xml, NS, 'reach');
        var results = [];
        if (reach.length) {
            var addrs = stanza.find(reach[0], NS, 'addr');
            _.forEach(addrs, function (addr) {
                results.push(new ReachURI({}, addr));
            });
        }
        return results;
    },
    set: function (value) {
        var reach = stanza.findOrCreate(this.xml, NS, 'reach');
        stanza.setAttribute(reach, 'xmlns', NS);
        _.forEach(value, function (info) {
            var addr = new ReachURI(info);
            reach.appendChild(addr.xml);
        });
    }
};


stanza.add(Item, 'reach', reachability);
stanza.add(EventItem, 'reach', reachability);
stanza.add(Presence, 'reach', reachability);

},{"./presence":77,"./pubsub":80,"./pubsubEvents":82,"jxt":204,"underscore":222}],85:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Iq = _dereq_('./iq');
var DataForm = _dereq_('./dataforms').DataForm;
var OOB = _dereq_('./oob');

var NS = 'jabber:iq:register';


var Register = module.exports = stanza.define({
    name: 'register',
    namespace: NS,
    element: 'query',
    fields: {
        instructions: stanza.subText(NS, 'instructions'),
        registered: stanza.boolSub(NS, 'registered'),
        remove: stanza.boolSub(NS, 'remove'),
        username: stanza.subText(NS, 'username'),
        nick: stanza.subText(NS, 'nick'),
        password: stanza.subText(NS, 'password'),
        name: stanza.subText(NS, 'name'),
        first: stanza.subText(NS, 'first'),
        last: stanza.subText(NS, 'last'),
        email: stanza.subText(NS, 'email'),
        address: stanza.subText(NS, 'address'),
        city: stanza.subText(NS, 'city'),
        state: stanza.subText(NS, 'state'),
        zip: stanza.subText(NS, 'zip'),
        phone: stanza.subText(NS, 'phone'),
        url: stanza.subText(NS, 'url'),
        date: stanza.subText(NS, 'date'),
        misc: stanza.subText(NS, 'misc'),
        text: stanza.subText(NS, 'text'),
        key: stanza.subText(NS, 'key')
    }
});


stanza.extend(Iq, Register);
stanza.extend(Register, DataForm);
stanza.extend(Register, OOB);

},{"./dataforms":55,"./iq":66,"./oob":75,"jxt":204}],86:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Iq = _dereq_('./iq');

var NS = 'jabber:iq:roster';


var Roster = module.exports = stanza.define({
    name: 'roster',
    namespace: NS,
    element: 'query',
    fields: {
        ver: {
            get: function () {
                return stanza.getAttribute(this.xml, 'ver');
            },
            set: function (value) {
                var force = (value === '');
                stanza.setAttribute(this.xml, 'ver', value, force);
            }
        }
    }
});

var RosterItem = stanza.define({
    name: '_rosterItem',
    namespace: NS,
    element: 'item',
    fields: {
        jid: util.jidAttribute('jid', true),
        name: stanza.attribute('name'),
        subscription: stanza.attribute('subscription', 'none'),
        subscriptionRequested: {
            get: function () {
                var ask = stanza.getAttribute(this.xml, 'ask');
                return ask === 'subscribe';
            }
        },
        preApproved: stanza.boolAttribute(NS, 'approved'),
        groups: stanza.multiSubText(NS, 'group')
    }
});


stanza.extend(Iq, Roster);
stanza.extend(Roster, RosterItem, 'items');

},{"./iq":66,"./util":98,"jxt":204}],87:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');


var NS = 'http://jabber.org/protocol/rsm';


module.exports = stanza.define({
    name: 'rsm',
    namespace: NS,
    element: 'set',
    fields: {
        after: stanza.subText(NS, 'after'),
        before: {
            get: function () {
                return stanza.getSubText(this.xml, this._NS, 'before');
            },
            set: function (value) {
                if (value === true) {
                    stanza.findOrCreate(this.xml, this._NS, 'before');
                } else {
                    stanza.setSubText(this.xml, this._NS, 'before', value);
                }
            }
        },
        count: stanza.numberSub(NS, 'count', false, 0),
        first: stanza.subText(NS, 'first'),
        firstIndex: stanza.subAttribute(NS, 'first', 'index'),
        index: stanza.subText(NS, 'index'),
        last: stanza.subText(NS, 'last'),
        max: stanza.subText(NS, 'max')
    }
});

},{"jxt":204}],88:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var jingle = _dereq_('./jingle');

var NS = 'urn:xmpp:jingle:apps:rtp:1';
var FBNS = 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0';
var HDRNS = 'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0';
var INFONS = 'urn:xmpp:jingle:apps:rtp:info:1';
var SSMANS = 'urn:xmpp:jingle:apps:rtp:ssma:0';
var GROUPNS = 'urn:xmpp:jingle:apps:grouping:0';


var Feedback = {
    get: function () {
        var existing = stanza.find(this.xml, FBNS, 'rtcp-fb');
        var result = [];
        existing.forEach(function (xml) {
            result.push({
                type: stanza.getAttribute(xml, 'type'),
                subtype: stanza.getAttribute(xml, 'subtype')
            });
        });
        existing = stanza.find(this.xml, FBNS, 'rtcp-fb-trr-int');
        existing.forEach(function (xml) {
            result.push({
                type: stanza.getAttribute(xml, 'type'),
                value: stanza.getAttribute(xml, 'value')
            });
        });
        return result;
    },
    set: function (values) {
        var self = this;
        var existing = stanza.find(this.xml, FBNS, 'rtcp-fb');
        existing.forEach(function (item) {
            self.xml.removeChild(item);
        });
        existing = stanza.find(this.xml, FBNS, 'rtcp-fb-trr-int');
        existing.forEach(function (item) {
            self.xml.removeChild(item);
        });

        values.forEach(function (value) {
            var fb;
            if (value.type === 'trr-int') {
                fb = stanza.createElement(FBNS, 'rtcp-fb-trr-int', NS);
                stanza.setAttribute(fb, 'type', value.type);
                stanza.setAttribute(fb, 'value', value.value);
            } else {
                fb = stanza.createElement(FBNS, 'rtcp-fb', NS);
                stanza.setAttribute(fb, 'type', value.type);
                stanza.setAttribute(fb, 'subtype', value.subtype);
            }
            self.xml.appendChild(fb);
        });
    }
};


exports.RTP = stanza.define({
    name: '_rtp',
    namespace: NS,
    element: 'description',
    fields: {
        descType: {value: 'rtp'},
        media: stanza.attribute('media'),
        ssrc: stanza.attribute('ssrc'),
        bandwidth: stanza.subText(NS, 'bandwidth'),
        bandwidthType: stanza.subAttribute(NS, 'bandwidth', 'type'),
        mux: stanza.boolSub(NS, 'rtcp-mux'),
        encryption: {
            get: function () {
                var enc = stanza.find(this.xml, NS, 'encryption');
                if (!enc.length) {
                    return [];
                }
                enc = enc[0];

                var self = this;
                var data = stanza.find(enc, NS, 'crypto');
                var results = [];

                data.forEach(function (xml) {
                    results.push(new exports.Crypto({}, xml, self).toJSON());
                });
                return results;
            },
            set: function (values) {
                var enc = stanza.find(this.xml, NS, 'encryption');
                if (enc.length) {
                    this.xml.removeChild(enc);
                }

                if (!values.length) {
                    return;
                }

                stanza.setBoolSubAttribute(this.xml, NS, 'encryption', 'required', true);
                enc = stanza.find(this.xml, NS, 'encryption')[0];

                var self = this;
                values.forEach(function (value) {
                    var content = new exports.Crypto(value, null, self);
                    enc.appendChild(content.xml);
                });
            }
        },
        feedback: Feedback,
        headerExtensions: {
            get: function () {
                var existing = stanza.find(this.xml, HDRNS, 'rtp-hdrext');
                var result = [];
                existing.forEach(function (xml) {
                    result.push({
                        id: stanza.getAttribute(xml, 'id'),
                        uri: stanza.getAttribute(xml, 'uri'),
                        senders: stanza.getAttribute(xml, 'senders')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                var existing = stanza.find(this.xml, HDRNS, 'rtp-hdrext');
                existing.forEach(function (item) {
                    self.xml.removeChild(item);
                });

                values.forEach(function (value) {
                    var hdr = stanza.createElement(HDRNS, 'rtp-hdrext', NS);
                    stanza.setAttribute(hdr, 'id', value.id);
                    stanza.setAttribute(hdr, 'uri', value.uri);
                    stanza.setAttribute(hdr, 'senders', value.senders);
                    self.xml.appendChild(hdr);
                });
            }
        }
    }
});


exports.PayloadType = stanza.define({
    name: '_payloadType',
    namespace: NS,
    element: 'payload-type',
    fields: {
        channels: stanza.attribute('channels'),
        clockrate: stanza.attribute('clockrate'),
        id: stanza.attribute('id'),
        maxptime: stanza.attribute('maxptime'),
        name: stanza.attribute('name'),
        ptime: stanza.attribute('ptime'),
        feedback: Feedback,
        parameters: {
            get: function () {
                var result = [];
                var params = stanza.find(this.xml, NS, 'parameter');
                params.forEach(function (param) {
                    result.push({
                        key: stanza.getAttribute(param, 'name'),
                        value: stanza.getAttribute(param, 'value')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (value) {
                    var param = stanza.createElement(NS, 'parameter');
                    stanza.setAttribute(param, 'name', value.key);
                    stanza.setAttribute(param, 'value', value.value);
                    self.xml.appendChild(param);
                });
            }
        }
    }
});


exports.Crypto = stanza.define({
    name: 'crypto',
    namespace: NS,
    element: 'crypto',
    fields: {
        cipherSuite: stanza.attribute('crypto-suite'),
        keyParams: stanza.attribute('key-params'),
        sessionParams: stanza.attribute('session-params'),
        tag: stanza.attribute('tag')
    }
});


exports.ContentGroup = stanza.define({
    name: '_group',
    namespace: GROUPNS,
    element: 'group',
    fields: {
        semantics: stanza.attribute('semantics'),
        contents: stanza.multiSubAttribute(GROUPNS, 'content', 'name')
    }
});

exports.SourceGroup = stanza.define({
    name: '_sourceGroup',
    namespace: SSMANS,
    element: 'ssrc-group',
    fields: {
        semantics: stanza.attribute('semantics'),
        sources: stanza.multiSubAttribute(SSMANS, 'source', 'ssrc')
    }
});

exports.Source = stanza.define({
    name: '_source',
    namespace: SSMANS,
    element: 'source',
    fields: {
        ssrc: stanza.attribute('ssrc'),
        parameters: {
            get: function () {
                var result = [];
                var params = stanza.find(this.xml, SSMANS, 'parameter');
                params.forEach(function (param) {
                    result.push({
                        key: stanza.getAttribute(param, 'name'),
                        value: stanza.getAttribute(param, 'value')
                    });
                });
                return result;
            },
            set: function (values) {
                var self = this;
                values.forEach(function (value) {
                    var param = stanza.createElement(SSMANS, 'parameter');
                    stanza.setAttribute(param, 'name', value.key);
                    stanza.setAttribute(param, 'value', value.value);
                    self.xml.appendChild(param);
                });
            }
        }
    }
});


exports.Mute = stanza.define({
    name: 'mute',
    namespace: INFONS,
    element: 'mute',
    fields: {
        creator: stanza.attribute('creator'),
        name: stanza.attribute('name')
    }
});


exports.Unmute = stanza.define({
    name: 'unmute',
    namespace: INFONS,
    element: 'unmute',
    fields: {
        creator: stanza.attribute('creator'),
        name: stanza.attribute('name')
    }
});


jingle.registerDescription(exports.RTP);

stanza.extend(jingle.Content, exports.RTP);
stanza.extend(exports.RTP, exports.PayloadType, 'payloads');
stanza.extend(exports.RTP, exports.Source, 'sources');
stanza.extend(exports.RTP, exports.SourceGroup, 'sourceGroups');

stanza.extend(jingle.Jingle, exports.Mute);
stanza.extend(jingle.Jingle, exports.Unmute);
stanza.extend(jingle.Jingle, exports.ContentGroup, 'groups');
stanza.add(jingle.Jingle, 'ringing', stanza.boolSub(INFONS, 'ringing'));
stanza.add(jingle.Jingle, 'hold', stanza.boolSub(INFONS, 'hold'));
stanza.add(jingle.Jingle, 'active', stanza.boolSub(INFONS, 'active'));

},{"./jingle":67,"jxt":204}],89:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');

var Message = _dereq_('./message');

var NS = 'urn:xmpp:rtt:0';

var typemap = {
    'insert': 't',
    'erase': 'e',
    'wait': 'w',
};

var actionmap = {
    't': 'insert',
    'e': 'erase',
    'w': 'wait'
};


var RTT = module.exports = stanza.define({
    name: 'rtt',
    namespace: NS,
    element: 'rtt',
    fields: {
        id: stanza.attribute('id'),
        event: stanza.attribute('event', 'edit'),
        seq: stanza.numberAttribute('seq'),
        actions: {
            get: function () {
                var results = [];
                for(var i = 0, len = this.xml.childNodes.length; i < len; i++) {
                    var child = this.xml.childNodes[i];
                    var name = child.localName;
                    var action = {};

                    if (child.namespaceURI !== NS) {
                        continue;
                    }

                    if (actionmap[name]) {
                        action.type = actionmap[name];
                    } else {
                        continue;
                    }

                    var pos = stanza.getAttribute(child, 'p');
                    if (pos) {
                        action.pos = parseInt(pos, 10);
                    }

                    var n = stanza.getAttribute(child, 'n');
                    if (n) {
                        action.num = parseInt(n, 10);
                    }

                    var t = stanza.getText(child);
                    if (t && name === 't') {
                        action.text = t;
                    }


                    results.push(action);
                }

                return results;
            },
            set: function (actions) {
                var self = this;

                for (var i = 0, len = this.xml.childNodes.length; i < len; i++) {
                    this.xml.removeChild(this.xml.childNodes[i]);
                }

                actions.forEach(function (action ) {
                    if (!typemap[action.type]) {
                        return;
                    }

                    var child = stanza.createElement(NS, typemap[action.type], NS);

                    if (action.pos !== undefined) {
                        stanza.setAttribute(child, 'p', action.pos.toString());
                    }

                    if (action.num) {
                        stanza.setAttribute(child, 'n', action.num.toString());
                    }

                    if (action.text) {
                        stanza.setText(child, action.text);
                    }

                    self.xml.appendChild(child);
                });
            }
        }
    }
});


stanza.extend(Message, RTT);

},{"./message":71,"jxt":204}],90:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var StreamFeatures = _dereq_('./streamFeatures');

var NS = 'urn:ietf:params:xml:ns:xmpp-sasl';
var CONDITIONS = [
    'aborted', 'account-disabled', 'credentials-expired',
    'encryption-required', 'incorrect-encoding', 'invalid-authzid',
    'invalid-mechanism', 'malformed-request', 'mechanism-too-weak',
    'not-authorized', 'temporary-auth-failure'
];

exports.Mechanisms = stanza.define({
    name: 'sasl',
    namespace: NS,
    element: 'mechanisms',
    fields: {
        mechanisms: stanza.multiSubText(NS, 'mechanism')
    }
});

exports.Auth = stanza.define({
    name: 'saslAuth',
    eventName: 'sasl:auth',
    namespace: NS,
    element: 'auth',
    topLevel: true,
    fields: {
        value: stanza.b64Text(),
        mechanism: stanza.attribute('mechanism')
    }
});

exports.Challenge = stanza.define({
    name: 'saslChallenge',
    eventName: 'sasl:challenge',
    namespace: NS,
    element: 'challenge',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Response = stanza.define({
    name: 'saslResponse',
    eventName: 'sasl:response',
    namespace: NS,
    element: 'response',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Abort = stanza.define({
    name: 'saslAbort',
    eventName: 'sasl:abort',
    namespace: NS,
    element: 'abort',
    topLevel: true
});

exports.Success = stanza.define({
    name: 'saslSuccess',
    eventName: 'sasl:success',
    namespace: NS,
    element: 'success',
    topLevel: true,
    fields: {
        value: stanza.b64Text()
    }
});

exports.Failure = stanza.define({
    name: 'saslFailure',
    eventName: 'sasl:failure',
    namespace: NS,
    element: 'failure',
    topLevel: true,
    fields: {
        lang: {
            get: function () {
                return this._lang || '';
            },
            set: function (value) {
                this._lang = value;
            }
        },
        condition: util.enumSub(NS, CONDITIONS),
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, NS, 'text', value, this.lang);
            }
        }
    }
});


stanza.extend(StreamFeatures, exports.Mechanisms);

},{"./streamFeatures":96,"./util":98,"jxt":204}],91:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var StreamFeatures = _dereq_('./streamFeatures');

var NS = 'urn:ietf:params:xml:ns:xmpp-session';

var Session = module.exports = stanza.define({
    name: 'session',
    namespace: NS,
    element: 'session',
    fields: {
        required: stanza.boolSub(NS, 'required'),
        optional: stanza.boolSub(NS, 'optional')
    }
});

stanza.extend(StreamFeatures, Session);
stanza.extend(Iq, Session);

},{"./iq":66,"./streamFeatures":96,"jxt":204}],92:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Message = _dereq_('./message');
var Presence = _dereq_('./presence');


var NS = 'http://jabber.org/protocol/shim';


var SHIM = module.exports = {
    get: function () {
        var headerSet = stanza.find(this.xml, NS, 'headers');
        if (headerSet.length) {
            return stanza.getMultiSubText(headerSet[0], NS, 'header', function (header) {
                var name = stanza.getAttribute(header, 'name');
                if (name) {
                    return {
                        name: name,
                        value: stanza.getText(header)
                    };
                }
            });
        }
        return [];
    },
    set: function (values) {
        var headerSet = stanza.findOrCreate(this.xml, NS, 'headers');
        stanza.setMultiSubText(headerSet, NS, 'header', values, function (val) {
            var header = stanza.createElement(NS, 'header', NS);
            stanza.setAttribute(header, 'name', val.name);
            stanza.setText(header, val.value);
            headerSet.appendChild(header);
        });
    }
};


stanza.add(Message, 'headers', SHIM);
stanza.add(Presence, 'headers', SHIM);

},{"./message":71,"./presence":77,"jxt":204}],93:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var StreamFeatures = _dereq_('./streamFeatures');


var NS = 'urn:xmpp:sm:3';


exports.SMFeature = stanza.define({
    name: 'streamManagement',
    namespace: NS,
    element: 'sm'
});

exports.Enable = stanza.define({
    name: 'smEnable',
    eventName: 'stream:management:enable',
    namespace: NS,
    element: 'enable',
    topLevel: true,
    fields: {
        resume: stanza.boolAttribute('resume')
    }
});

exports.Enabled = stanza.define({
    name: 'smEnabled',
    eventName: 'stream:management:enabled',
    namespace: NS,
    element: 'enabled',
    topLevel: true,
    fields: {
        id: stanza.attribute('id'),
        resume: stanza.boolAttribute('resume')
    }
});

exports.Resume = stanza.define({
    name: 'smResume',
    eventName: 'stream:management:resume',
    namespace: NS,
    element: 'resume',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0),
        previd: stanza.attribute('previd')
    }
});

exports.Resumed = stanza.define({
    name: 'smResumed',
    eventName: 'stream:management:resumed',
    namespace: NS,
    element: 'resumed',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0),
        previd: stanza.attribute('previd')
    }
});

exports.Failed = stanza.define({
    name: 'smFailed',
    eventName: 'stream:management:failed',
    namespace: NS,
    element: 'failed',
    topLevel: true
});

exports.Ack = stanza.define({
    name: 'smAck',
    eventName: 'stream:management:ack',
    namespace: NS,
    element: 'a',
    topLevel: true,
    fields: {
        h: stanza.numberAttribute('h', false, 0)
    }
});

exports.Request = stanza.define({
    name: 'smRequest',
    eventName: 'stream:management:request',
    namespace: NS,
    element: 'r',
    topLevel: true
});


stanza.extend(StreamFeatures, exports.SMFeature);

},{"./streamFeatures":96,"jxt":204}],94:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');


module.exports = stanza.define({
    name: 'stream',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'stream',
    fields: {
        lang: stanza.langAttribute(),
        id: stanza.attribute('id'),
        version: stanza.attribute('version', '1.0'),
        to: util.jidAttribute('to', true),
        from: util.jidAttribute('from', true)
    }
});

},{"./util":98,"jxt":204}],95:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');


var ERR_NS = 'urn:ietf:params:xml:ns:xmpp-streams';
var CONDITIONS = [
    'bad-format', 'bad-namespace-prefix', 'conflict',
    'connection-timeout', 'host-gone', 'host-unknown',
    'improper-addressing', 'internal-server-error', 'invalid-from',
    'invalid-namespace', 'invalid-xml', 'not-authorized',
    'not-well-formed', 'policy-violation', 'remote-connection-failed',
    'reset', 'resource-constraint', 'restricted-xml', 'see-other-host',
    'system-shutdown', 'undefined-condition', 'unsupported-encoding',
    'unsupported-feature', 'unsupported-stanza-type',
    'unsupported-version'
];

module.exports = stanza.define({
    name: 'streamError',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'error',
    topLevel: true,
    fields: {
        lang: {
            get: function () {
                return this._lang || '';
            },
            set: function (value) {
                this._lang = value;
            }
        },
        condition: util.enumSub(ERR_NS, CONDITIONS),
        seeOtherHost: {
            get: function () {
                return stanza.getSubText(this.xml, ERR_NS, 'see-other-host');
            },
            set: function (value) {
                this.condition = 'see-other-host';
                stanza.setSubText(this.xml, ERR_NS, 'see-other-host', value);
            }
        },
        $text: {
            get: function () {
                return stanza.getSubLangText(this.xml, ERR_NS, 'text', this.lang);
            }
        },
        text: {
            get: function () {
                var text = this.$text;
                return text[this.lang] || '';
            },
            set: function (value) {
                stanza.setSubLangText(this.xml, ERR_NS, 'text', value, this.lang);
            }
        }
    }
});

},{"./util":98,"jxt":204}],96:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');


var StreamFeatures = module.exports = stanza.define({
    name: 'streamFeatures',
    namespace: 'http://etherx.jabber.org/streams',
    element: 'features',
    topLevel: true
});

var RosterVerFeature = stanza.define({
    name: 'rosterVersioning',
    namespace: 'urn:xmpp:features:rosterver',
    element: 'ver'
});

var SubscriptionPreApprovalFeature = stanza.define({
    name: 'subscriptionPreApproval',
    namespace: 'urn:xmpp:features:pre-approval',
    element: 'sub'
});


stanza.extend(StreamFeatures, RosterVerFeature);
stanza.extend(StreamFeatures, SubscriptionPreApprovalFeature);

},{"jxt":204}],97:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var util = _dereq_('./util');
var Iq = _dereq_('./iq');


var EntityTime = module.exports = stanza.define({
    name: 'time',
    namespace: 'urn:xmpp:time',
    element: 'time',
    fields: {
        utc: stanza.dateSub('urn:xmpp:time', 'utc'),
        tzo: util.tzoSub('urn:xmpp:time', 'tzo', 0)
    }
});


stanza.extend(Iq, EntityTime);

},{"./iq":66,"./util":98,"jxt":204}],98:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var stanza = _dereq_('jxt');
var JID = _dereq_('xmpp-jid').JID;


exports.jidAttribute = function (attr, prepped) {
    return {
        get: function () {
            var jid = new JID(stanza.getAttribute(this.xml, attr));
            if (prepped) {
                jid.prepped = true;
            }
            return jid;
        },
        set: function (value) {
            stanza.setAttribute(this.xml, attr, (value || '').toString());
        }
    };
};

exports.jidSub = function (NS, sub, prepped) {
    return {
        get: function () {
            var jid = new JID(stanza.getSubText(this.xml, NS, sub));
            if (prepped) {
                jid.prepped = true;
            }
            return jid;
        },
        set: function (value) {
            stanza.setSubText(this.xml, NS, sub, (value || '').toString());
        }
    };
};

exports.tzoSub = stanza.field(
    function (xml, NS, sub, defaultVal) {
        var split, hrs, min;
        var sign = -1;
        var formatted = stanza.getSubText(xml, NS, sub);

        if (!formatted) {
            return defaultVal;
        }

        if (formatted.charAt(0) === '-') {
            sign = 1;
            formatted = formatted.slice(1);
        }

        split = formatted.split(':');
        hrs = parseInt(split[0], 10);
        min = parseInt(split[1], 10);
        return (hrs * 60 + min) * sign;
    },
    function (xml, NS, sub, value) {
        var hrs, min;
        var formatted = '-';
        if (typeof value === 'number') {
            if (value < 0) {
                value = -value;
                formatted = '+';
            }
            hrs = value / 60;
            min = value % 60;
            formatted += (hrs < 10 ? '0' : '') + hrs + ':' + (min < 10 ? '0' : '') + min;
        } else {
            formatted = value;
        }
        stanza.setSubText(xml, NS, sub, formatted);
    }
);

exports.enumSub = function (NS, enumValues) {
    return {
        get: function () {
            var self = this;
            var result = [];
            enumValues.forEach(function (enumVal) {
                var exists = stanza.find(self.xml, NS, enumVal);
                if (exists.length) {
                    result.push(exists[0].tagName);
                }
            });
            return result[0] || '';
        },
        set: function (value) {
            var self = this;
            enumValues.forEach(function (enumVal) {
                var exists = stanza.find(self.xml, NS, enumVal);
                if (exists.length) {
                    self.xml.removeChild(exists[0]);
                }
            });

            if (value) {
                var condition = stanza.createElement(NS, value);
                this.xml.appendChild(condition);
            }
        }
    };
};

exports.subExtension = function (name, NS, sub, ChildJXT) {
    return {
        get: function () {
            if (!this._extensions[name]) {
                var wrapper = stanza.find(this.xml, NS, sub);
                if (!wrapper.length) {
                    wrapper= stanza.createElement(NS, sub, this._NS);
                    this.xml.appendChild(wrapper);
                } else {
                    wrapper = wrapper[0];
                }

                var existing = stanza.find(wrapper, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
                if (!existing.length) {
                    this._extensions[name] = new ChildJXT({}, null, {xml: wrapper});
                    wrapper.appendChild(this._extensions[name].xml);
                } else {
                    this._extensions[name] = new ChildJXT(null, existing[0], {xml: wrapper});
                }
                this._extensions[name].parent = this;
            }
            return this._extensions[name];
        },
        set: function (value) {
            var wrapper = stanza.find(this.xml, NS, sub);
            if (wrapper.length && !value) {
                this.xml.removeChild(wrapper[0]);
            }

            if (value) {
                var child = this[name];
                if (value === true) {
                    value = {};
                }
                _.extend(child, value);
            }
        }
    };
};

exports.subMultiExtension = function (NS, sub, ChildJXT) {
    return {
        get: function () {
            var self = this;
            var results = [];
            var existing = stanza.find(this.xml, NS, sub);
            if (!existing.length) {
                return results;
            }
            existing = existing[0];
            var data = stanza.find(existing, ChildJXT.prototype._NS, ChildJXT.prototype._EL);

            data.forEach(function (xml) {
                results.push(new ChildJXT({}, xml, self));
            });
            return results;
        },
        set: function (values) {
            var self = this;
            var existing = stanza.find(this.xml, NS, sub);
            if (existing.length) {
                self.xml.removeChild(existing[0]);
            }

            if (!values.length) {
                return;
            }

            existing = stanza.createElement(NS, sub, this._NS);

            values.forEach(function (value) {
                var content = new ChildJXT(value, null, self);
                existing.appendChild(content.xml);
            });

            self.xml.appendChild(existing);
        }
    };
};

},{"jxt":204,"underscore":222,"xmpp-jid":225}],99:[function(_dereq_,module,exports){
'use strict';

var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');
var NS = 'vcard-temp';


var VCardTemp = module.exports = stanza.define({
    name: 'vCardTemp',
    namespace: NS,
    element: 'vCard',
    fields: {
        role: stanza.subText(NS, 'ROLE'),
        website: stanza.subText(NS, 'URL'),
        title: stanza.subText(NS, 'TITLE'),
        description: stanza.subText(NS, 'DESC'),
        fullName: stanza.subText(NS, 'FN'),
        birthday: stanza.dateSub(NS, 'BDAY'),
        nicknames: stanza.multiSubText(NS, 'NICKNAME'),
        jids: stanza.multiSubText(NS, 'JABBERID')
    }
});

var Email = stanza.define({
    name: '_email',
    namespace: NS,
    element: 'EMAIL',
    fields: {
        email: stanza.subText(NS, 'USERID'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var PhoneNumber = stanza.define({
    name: '_tel',
    namespace: NS,
    element: 'TEL',
    fields: {
        number: stanza.subText(NS, 'NUMBER'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        mobile: stanza.boolSub(NS, 'CELL'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var Address = stanza.define({
    name: '_address',
    namespace: NS,
    element: 'ADR',
    fields: {
        street: stanza.subText(NS, 'STREET'),
        street2: stanza.subText(NS, 'EXTADD'),
        country: stanza.subText(NS, 'CTRY'),
        city: stanza.subText(NS, 'LOCALITY'),
        region: stanza.subText(NS, 'REGION'),
        postalCode: stanza.subText(NS, 'PCODE'),
        pobox: stanza.subText(NS, 'POBOX'),
        home: stanza.boolSub(NS, 'HOME'),
        work: stanza.boolSub(NS, 'WORK'),
        preferred: stanza.boolSub(NS, 'PREF')
    }
});

var Organization = stanza.define({
    name: 'organization',
    namespace: NS,
    element: 'ORG',
    fields: {
        name: stanza.subText(NS, 'ORGNAME'),
        unit: stanza.subText(NS, 'ORGUNIT')
    }
});

var Name = stanza.define({
    name: 'name',
    namespace: NS,
    element: 'N',
    fields: {
        family: stanza.subText(NS, 'FAMILY'),
        given: stanza.subText(NS, 'GIVEN'),
        middle: stanza.subText(NS, 'MIDDLE'),
        prefix: stanza.subText(NS, 'PREFIX'),
        suffix: stanza.subText(NS, 'SUFFIX')
    }
});

var Photo = stanza.define({
    name: 'photo',
    namespace: NS,
    element: 'PHOTO',
    fields: {
        type: stanza.subText(NS, 'TYPE'),
        data: stanza.subText(NS, 'BINVAL'),
        url: stanza.subText(NS, 'EXTVAL')
    }
});


stanza.extend(VCardTemp, Email, 'emails');
stanza.extend(VCardTemp, Address, 'addresses');
stanza.extend(VCardTemp, PhoneNumber, 'phoneNumbers');
stanza.extend(VCardTemp, Organization);
stanza.extend(VCardTemp, Name);
stanza.extend(VCardTemp, Photo);
stanza.extend(Iq, VCardTemp);

},{"./iq":66,"jxt":204}],100:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');

var NS = 'jabber:iq:version';

var Version = module.exports = stanza.define({
    name: 'version',
    namespace: NS,
    element: 'query',
    fields: {
        name: stanza.subText(NS, 'name'),
        version: stanza.subText(NS, 'version'),
        os: stanza.subText(NS, 'os')
    }
});

stanza.extend(Iq, Version);

},{"./iq":66,"jxt":204}],101:[function(_dereq_,module,exports){
var stanza = _dereq_('jxt');
var Iq = _dereq_('./iq');


stanza.add(Iq, 'visible', stanza.boolSub('urn:xmpp:invisible:0', 'visible'));
stanza.add(Iq, 'invisible', stanza.boolSub('urn:xmpp:invisible:0', 'invisible'));

},{"./iq":66,"jxt":204}],102:[function(_dereq_,module,exports){
(function (process,Buffer){
'use strict';

var _ = _dereq_('underscore');
var util = _dereq_('util');
var utf8 = _dereq_('utf8');
var Promise = _dereq_('bluebird');
var request = Promise.promisify(_dereq_('request'));

var WildEmitter = _dereq_('wildemitter');
var stanza = _dereq_('jxt');
var BOSH = _dereq_('../stanza/bosh');
var StreamError = _dereq_('../stanza/streamError');


function ConnectionError() {}
util.inherits(ConnectionError, Error);


function retryRequest(opts, timeout, allowedRetries, retries) {
    retries = retries || 0;

    var req = request(opts).cancellable().timeout((timeout || 20) * 1000);

    return req.spread(function (req, body) {
        if (req.statusCode < 200 || req.statusCode >= 400) {
            throw new ConnectionError('HTTP Status Error');
        }
        return body;
    }).catch(Promise.TimeoutError, function () {
        throw new ConnectionError('Dead Connection, exceeded timeout limit');
    }).catch(Promise.CancellationError, function () {
        return; // We only cancel on manual disconnect, so let things die silently
    }).catch(function () {
        if (retries < allowedRetries) {
            return Promise.delay(100).then(function () {
                return retryRequest(opts, timeout, allowedRetries, retries + 1);
            });
        } else {
            throw new ConnectionError('Dead Connection, exceeded retry limit');
        }
    });
}


function BOSHConnection(sm) {
    var self = this;

    WildEmitter.call(this);

    self.sm = sm;

    self.sendQueue = [];
    self.requests = [];
    self.maxRequests = 2;
    self.sid = '';

    self.on('raw:incoming', function (data) {
        data = data.trim();
        if (data === '') {
            return;
        }

        var bosh, err;

        try {
            bosh = stanza.parse(data, BOSH);
        } catch (e) {
            err = new StreamError({
                condition: 'invalid-xml'
            });
            self.emit('stream:error', err, e);
            self.send(err);
            return self.disconnect();
        }

        if (!self.hasStream) {
            self.hasStream = true;
            self.stream = {
                id: bosh.sid,
                lang: bosh.lang || 'en',
                version: bosh.version || '1.0',
                to: bosh.to,
                from: bosh.from
            };
            self.sid = bosh.sid;
            self.maxRequests = bosh.requests;
        }

        var payload = bosh.payload;
        payload.forEach(function (stanzaObj) {
            if (!stanzaObj.lang) {
                stanzaObj.lang = self.stream.lang;
            }

            self.emit('stream:data', stanzaObj);
        });

        if (bosh.type === 'terminate') {
            self.rid = undefined;
            self.sid = undefined;
            self.emit('bosh:terminate', bosh);
            self.emit('stream:end');
            self.emit('disconnected', self);
        }
    });
}

util.inherits(BOSHConnection, WildEmitter);

BOSHConnection.prototype.connect = function (opts) {
    var self = this;

    self.config = _.extend({
        rid: Math.ceil(Math.random() * 9999999999),
        wait: 30,
        maxRetries: 5
    }, opts);

    self.hasStream = false;
    self.sm.started = false;
    self.url = opts.boshURL;

    self.rid = self.config.rid;

    self.requests = [];

    self.rid++;
    self.request(new BOSH({
        version: self.config.version || '1.0',
        to: self.config.server,
        lang: self.config.lang || 'en',
        wait: self.config.wait,
        ver: '1.6',
        hold: 1
    }));
};

BOSHConnection.prototype.disconnect = function () {
    if (this.hasStream) {
        this.rid++;
        this.request(new BOSH({
            type: 'terminate'
        }));
    } else {
        this.requests.forEach(function (ticket) {
            ticket.request.cancel();
        });
        this.stream = undefined;
        this.sid = undefined;
        this.rid = undefined;
        this.emit('disconnected', this);
    }
};

BOSHConnection.prototype.restart = function () {
    var self = this;
    self.rid++;
    self.request(new BOSH({
        to: self.config.server,
        lang: self.config.lang || 'en',
        restart: 'true'
    }));
};

BOSHConnection.prototype.send = function (data) {
    var self = this;
    if (self.hasStream) {
        self.sendQueue.push(data);
        process.nextTick(self.longPoll.bind(self));
    }
};

BOSHConnection.prototype.longPoll = function () {
    var canReceive = this.requests.length === 0;
    var canSend = this.sendQueue.length > 0 && this.requests.length < this.maxRequests;

    if (!this.sid || (!canReceive && !canSend)) {
        return;
    }

    var stanzas = this.sendQueue;
    this.sendQueue = [];
    this.rid++;

    this.request(new BOSH({
        payload: stanzas
    }));
};

BOSHConnection.prototype.request = function (bosh) {
    var self = this;

    var ticket = {id: self.rid, request: null};
    bosh.rid = self.rid;
    bosh.sid = self.sid;

    var body = new Buffer(utf8.encode(bosh.toString())).toString();

    self.emit('raw:outgoing', body);

    self.requests.push(ticket);

    var req = retryRequest({
        uri: self.url,
        body: body,
        method: 'POST',
        strictSSL: true
    }, self.config.wait * 1.5, this.config.maxRetries);

    ticket.request = req;

    return req.then(function (body) {
        self.emit('raw:incoming', new Buffer(utf8.decode(body)).toString());
    }).catch(ConnectionError, function (err) {
        self.hasStream = false;
        var serr = new StreamError({
            condition: 'connection-timeout'
        });
        self.emit('stream:error', serr, err);
        self.disconnect();
    }).catch(function (err) {
        var serr = new StreamError({
            condition: 'undefined-condition'
        });
        self.emit('stream:error', serr, err);
        self.send(serr);
        self.disconnect();
    }).finally(function () {
        self.requests = _.filter(self.requests, function (item) {
            return item.id !== ticket.id;
        });
        if (bosh.type !== 'terminate') {
            // Delay next auto-request by two ticks since we're likely
            // to send data anyway next tick.
            process.nextTick(function () {
                process.nextTick(self.longPoll.bind(self));
            });
        }
    });
};

module.exports = BOSHConnection;

}).call(this,_dereq_("FWaASH"),_dereq_("buffer").Buffer)
},{"../stanza/bosh":51,"../stanza/streamError":95,"FWaASH":166,"bluebird":110,"buffer":148,"jxt":204,"request":145,"underscore":222,"utf8":223,"util":169,"wildemitter":224}],103:[function(_dereq_,module,exports){
'use strict';

var WSConnection = _dereq_('./websocket');
var _ = _dereq_('underscore');
var util = _dereq_('util');
var stanza = _dereq_('jxt');
var Stream = _dereq_('../stanza/stream');
var StreamError = _dereq_('../stanza/streamError');



function OldWSConnection(sm) {
    WSConnection.call(this, sm);

    var self = this;


    function wrap(data) {
        return [self.streamStart, data, self.streamEnd].join('');
    }


    self.on('connected', function () {
        self.streamStart = '<stream:stream xmlns:stream="http://etherx.jabber.org/streams">';
        self.streamEnd = '</stream:stream>';
    });

    self.off('raw:incoming');
    self.on('raw:incoming', function (data) {
        var streamData, ended, err;

        data = data.trim();
        data = data.replace(/^(\s*<\?.*\?>\s*)*/, '');
        if (data === '') {
            return;
        }

        if (data.match(self.streamEnd)) {
            return self.disconnect();
        } else if (self.hasStream) {
            try {
                streamData = stanza.parse(wrap(data), Stream);
            } catch (e) {
                err = new StreamError({
                    condition: 'invalid-xml'
                });
                self.emit('stream:error', err, e);
                self.send(err);
                return self.disconnect();
            }
        } else {
            // Inspect start of stream element to get NS prefix name
            var parts = data.match(/^<(\S+:)?(\S+) /);
            self.streamStart = data;
            self.streamEnd = '</' + (parts[1] || '') + parts[2] + '>';

            ended = false;
            try {
                streamData = stanza.parse(data + self.streamEnd, Stream);
            } catch (e) {
                try {
                    streamData = stanza.parse(data, Stream);
                    ended = true;
                } catch (e2) {
                    err = new StreamError({
                        condition: 'invalid-xml'
                    });
                    self.emit('stream:error', err, e2);
                    self.send(err);
                    return self.disconnect();
                }
            }

            self.hasStream = true;
            self.stream = streamData;
            self.emit('stream:start', streamData);
        }

        _.each(streamData._extensions, function (stanzaObj) {
            if (!stanzaObj.lang) {
                stanzaObj.lang = self.stream.lang;
            }

            self.emit('stream:data', stanzaObj);
        });

        if (ended) {
            self.emit('stream:end');
        }
    });
}

util.inherits(OldWSConnection, WSConnection);


OldWSConnection.prototype.startHeader = function () {
    return [
        '<stream:stream',
        'xmlns:stream="http://etherx.jabber.org/streams"',
        'xmlns="jabber:client"',
        'version="' + (this.config.version || '1.0') + '"',
        'xml:lang="' + (this.config.lang || 'en') + '"',
        'to="' + this.config.server + '">'
    ].join(' ');
};

OldWSConnection.prototype.closeHeader = function () {
    return '</stream:stream>';
};


module.exports = OldWSConnection;

},{"../stanza/stream":94,"../stanza/streamError":95,"./websocket":104,"jxt":204,"underscore":222,"util":169}],104:[function(_dereq_,module,exports){
(function (Buffer){
'use strict';

var util = _dereq_('util');
var utf8 = _dereq_('utf8');
var stanza = _dereq_('jxt');
var WildEmitter = _dereq_('wildemitter');
var async = _dereq_('async');
var framing = _dereq_('../stanza/framing');
var StreamError = _dereq_('../stanza/streamError');

var WS = (_dereq_('faye-websocket') && _dereq_('faye-websocket').Client) ?
                                       _dereq_('faye-websocket').Client :
                                       window.WebSocket;

var WS_OPEN = 1;



function WSConnection(sm) {
    var self = this;

    WildEmitter.call(this);

    self.sm = sm;
    self.closing = false;

    self.sendQueue = async.queue(function (data, cb) {
        if (self.conn) {
            if (typeof data !== 'string') {
                data = data.toString();
            }

            data = new Buffer(utf8.encode(data)).toString();

            self.emit('raw:outgoing', data);
            if (self.conn.readyState === WS_OPEN) {
                self.conn.send(data);
            }
        }
        cb();
    }, 1);

    self.on('connected', function () {
        self.send(self.startHeader());
    });

    self.on('raw:incoming', function (data) {
        var stanzaObj, err;

        data = data.trim();
        if (data === '') {
            return;
        }

        try {
            stanzaObj = stanza.parse(data);
        } catch (e) {
            err = new StreamError({
                condition: 'invalid-xml'
            });
            self.emit('stream:error', err, e);
            self.send(err);
            return self.disconnect();
        }

        if (stanzaObj._name === 'openStream') {
            self.hasStream = true;
            self.stream = stanzaObj;
            return self.emit('stream:start', stanzaObj.toJSON());
        }
        if (stanzaObj._name === 'closeStream') {
            self.emit('stream:end');
            return self.disconnect();
        }

        if (!stanzaObj.lang) {
            stanzaObj.lang = self.stream.lang;
        }

        self.emit('stream:data', stanzaObj);
    });
}

util.inherits(WSConnection, WildEmitter);

WSConnection.prototype.connect = function (opts) {
    var self = this;

    self.config = opts;

    self.hasStream = false;
    self.closing = false;

    self.conn = new WS(opts.wsURL, 'xmpp');
    self.conn.onerror = function (e) {
        e.preventDefault();
        self.emit('disconnected', self);
    };

    self.conn.onclose = function () {
        self.emit('disconnected', self);
    };

    self.conn.onopen = function () {
        self.sm.started = false;
        self.emit('connected', self);
    };

    self.conn.onmessage = function (wsMsg) {
        self.emit('raw:incoming', new Buffer(utf8.decode(wsMsg.data)).toString());
    };
};

WSConnection.prototype.startHeader = function () {
    return new framing.Open({
        version: this.config.version || '1.0',
        lang: this.config.lang || 'en',
        to: this.config.server
    });
};

WSConnection.prototype.closeHeader = function () {
    return new framing.Close();
};

WSConnection.prototype.disconnect = function () {
    if (this.conn && !this.closing) {
        this.closing = true;
        this.send(this.closeHeader());
    } else {
        this.hasStream = false;
        this.stream = undefined;
        if (this.conn.readyState === WS_OPEN) {
            this.conn.close();
        }
        this.conn = undefined;
    }
};

WSConnection.prototype.restart = function () {
    var self = this;
    self.hasStream = false;
    self.send(this.startHeader());
};

WSConnection.prototype.send = function (data) {
    this.sendQueue.push(data);
};


module.exports = WSConnection;

}).call(this,_dereq_("buffer").Buffer)
},{"../stanza/framing":62,"../stanza/streamError":95,"async":106,"buffer":148,"faye-websocket":147,"jxt":204,"utf8":223,"util":169,"wildemitter":224}],105:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');


function parse(chal) {
    var dtives = {};
    var tokens = chal.split(/,(?=(?:[^"]|"[^"]*")*$)/);
    for (var i = 0, len = tokens.length; i < len; i++) {
        var dtiv = /(\w+)=["]?([^"]+)["]?$/.exec(tokens[i]);
        if (dtiv) {
            dtives[dtiv[1]] = dtiv[2];
        }
    }
    return dtives;
}

function genNonce() {
    return crypto.randomBytes(16).toString('hex');
}



function Mechanism(options) {
    options = options || {};
    this._genNonce = options.genNonce || genNonce;
}

// Conform to the SASL lib's expectations
Mechanism.Mechanism = Mechanism;


Mechanism.prototype.name = 'DIGEST-MD5';
Mechanism.prototype.clientFirst = false;


Mechanism.prototype.response = function(cred) {
    if (this._completed) {
        return '';
    }

    var uri = cred.serviceType + '/' + cred.host;

    if (cred.serviceName && cred.host !== cred.serviceName) {
        uri += '/' + cred.serviceName;
    }

    var realm = cred.realm || this._realm || '';
    var cnonce = this._genNonce();
    var nc = '00000001';
    var qop = 'auth';

    var str = '';
    str += 'username="' + cred.username + '"';
    if (realm) {
        str += ',realm="' + realm + '"';
    }
    str += ',nonce="' + this._nonce + '"';
    str += ',cnonce="' + cnonce + '"';
    str += ',nc=' + nc;
    str += ',qop=' + qop;
    str += ',digest-uri="' + uri + '"';
  
    var base = crypto.createHash('md5').update(cred.username)
                                       .update(':')
                                       .update(realm)
                                       .update(':')
                                       .update(cred.password)
                                       .digest();

    var ha1 = crypto.createHash('md5').update(base)
                                      .update(':')
                                      .update(this._nonce)
                                      .update(':')
                                      .update(cnonce);


    if (cred.authzid) {
        ha1.update(':').update(cred.authzid);
    }

    ha1 = ha1.digest('hex');
  
    var ha2 = crypto.createHash('md5').update('AUTHENTICATE:')
                                      .update(uri);
    
    if (qop === 'auth-int' || qop === 'auth-conf') {
        ha2.update(':00000000000000000000000000000000');
    }

    ha2 = ha2.digest('hex');
  
    var digest = crypto.createHash('md5').update(ha1)
                                         .update(':')
                                         .update(this._nonce)
                                         .update(':')
                                         .update(nc)
                                         .update(':')
                                         .update(cnonce)
                                         .update(':')
                                         .update(qop)
                                         .update(':')
                                         .update(ha2)
                                         .digest('hex');

    str += ',response=' + digest;
  
    if (this._charset === 'utf-8') {
        str += ',charset=utf-8';
    }
    if (cred.authzid) {
        str += 'authzid="' + cred.authzid + '"';
    }
  
    return str;
};

Mechanism.prototype.challenge = function(chal) {
    var dtives = parse(chal);

    this._completed = !!dtives.rspauth;

    this._realm = dtives.realm;
    this._nonce = dtives.nonce;
    this._qop = (dtives.qop || 'auth').split(',');
    this._stale = dtives.stale;
    this._maxbuf = parseInt(dtives.maxbuf) || 65536;
    this._charset = dtives.charset;
    this._algo = dtives.algorithm;
    this._cipher = dtives.cipher;
    if (this._cipher) {
        this._cipher.split(',');
    }

    return this;
};



module.exports = Mechanism;

},{"crypto":154}],106:[function(_dereq_,module,exports){
(function (process){
/*!
 * async
 * https://github.com/caolan/async
 *
 * Copyright 2010-2014 Caolan McMahon
 * Released under the MIT license
 */
/*jshint onevar: false, indent:4 */
/*global setImmediate: false, setTimeout: false, console: false */
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

    var _toString = Object.prototype.toString;

    var _isArray = Array.isArray || function (obj) {
        return _toString.call(obj) === '[object Array]';
    };

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
            async.setImmediate = function (fn) {
              // not a direct alias for IE10 compatibility
              setImmediate(fn);
            };
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
            iterator(x, only_once(done) );
        });
        function done(err) {
          if (err) {
              callback(err);
              callback = function () {};
          }
          else {
              completed += 1;
              if (completed >= arr.length) {
                  callback();
              }
          }
        }
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
                        callback();
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
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        if (!callback) {
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err) {
                    callback(err);
                });
            });
        } else {
            var results = [];
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err, v) {
                    results[x.index] = v;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
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
        var remainingTasks = keys.length
        if (!remainingTasks) {
            return callback();
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
            remainingTasks--
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (!remainingTasks) {
                var theCallback = callback;
                // prevent final callback from calling itself if it errors
                callback = function () {};

                theCallback(null, results);
            }
        });

        _each(keys, function (k) {
            var task = _isArray(tasks[k]) ? tasks[k]: [tasks[k]];
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

    async.retry = function(times, task, callback) {
        var DEFAULT_TIMES = 5;
        var attempts = [];
        // Use defaults if times not passed
        if (typeof times === 'function') {
            callback = task;
            task = times;
            times = DEFAULT_TIMES;
        }
        // Make sure times is a number
        times = parseInt(times, 10) || DEFAULT_TIMES;
        var wrappedTask = function(wrappedCallback, wrappedResults) {
            var retryAttempt = function(task, finalAttempt) {
                return function(seriesCallback) {
                    task(function(err, result){
                        seriesCallback(!err || finalAttempt, {err: err, result: result});
                    }, wrappedResults);
                };
            };
            while (times) {
                attempts.push(retryAttempt(task, !(times-=1)));
            }
            async.series(attempts, function(done, data){
                data = data[data.length - 1];
                (wrappedCallback || callback)(data.err, data.result);
            });
        }
        // If a callback is passed, run this as a controll flow
        return callback ? wrappedTask() : wrappedTask
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (!_isArray(tasks)) {
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
        if (_isArray(tasks)) {
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
        if (_isArray(tasks)) {
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
            var args = Array.prototype.slice.call(arguments, 1);
            if (test.apply(null, args)) {
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
            var args = Array.prototype.slice.call(arguments, 1);
            if (!test.apply(null, args)) {
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
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
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

              if (q.saturated && q.tasks.length === q.concurrency) {
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
            started: false,
            paused: false,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            kill: function () {
              q.drain = null;
              q.tasks = [];
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (!q.paused && workers < q.concurrency && q.tasks.length) {
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
            },
            idle: function() {
                return q.tasks.length + workers === 0;
            },
            pause: function () {
                if (q.paused === true) { return; }
                q.paused = true;
                q.process();
            },
            resume: function () {
                if (q.paused === false) { return; }
                q.paused = false;
                q.process();
            }
        };
        return q;
    };
    
    async.priorityQueue = function (worker, concurrency) {
        
        function _compareTasks(a, b){
          return a.priority - b.priority;
        };
        
        function _binarySearch(sequence, item, compare) {
          var beg = -1,
              end = sequence.length - 1;
          while (beg < end) {
            var mid = beg + ((end - beg + 1) >>> 1);
            if (compare(item, sequence[mid]) >= 0) {
              beg = mid;
            } else {
              end = mid - 1;
            }
          }
          return beg;
        }
        
        function _insert(q, data, priority, callback) {
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
          }
          _each(data, function(task) {
              var item = {
                  data: task,
                  priority: priority,
                  callback: typeof callback === 'function' ? callback : null
              };
              
              q.tasks.splice(_binarySearch(q.tasks, item, _compareTasks) + 1, 0, item);

              if (q.saturated && q.tasks.length === q.concurrency) {
                  q.saturated();
              }
              async.setImmediate(q.process);
          });
        }
        
        // Start with a normal queue
        var q = async.queue(worker, concurrency);
        
        // Override push to accept second parameter representing priority
        q.push = function (data, priority, callback) {
          _insert(q, data, priority, callback);
        };
        
        // Remove unshift function
        delete q.unshift;

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
            drained: true,
            push: function (data, callback) {
                if (!_isArray(data)) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    cargo.drained = false;
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain && !cargo.drained) cargo.drain();
                    cargo.drained = true;
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0, tasks.length);

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
                async.nextTick(function () {
                    callback.apply(null, memo[key]);
                });
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

    async.seq = function (/* functions... */) {
        var fns = arguments;
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

    async.compose = function (/* functions... */) {
      return async.seq.apply(null, Array.prototype.reverse.call(arguments));
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

    // Node.js
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // AMD / RequireJS
    else if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],107:[function(_dereq_,module,exports){
(function (Buffer){
(function () {
  "use strict";

  function atob(str) {
    return new Buffer(str, 'base64').toString('binary');
  }

  module.exports = atob;
}());

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],108:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, Promise$_CreatePromiseArray, PromiseArray) {

var SomePromiseArray = _dereq_("./some_promise_array.js")(PromiseArray);
function Promise$_Any(promises, useBound) {
    var ret = Promise$_CreatePromiseArray(
        promises,
        SomePromiseArray,
        useBound === true && promises._isBound()
            ? promises._boundTo
            : void 0
   );
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(1);
    ret.setUnwrap();
    ret.init();
    return promise;
}

Promise.any = function Promise$Any(promises) {
    return Promise$_Any(promises, false);
};

Promise.prototype.any = function Promise$any() {
    return Promise$_Any(this, true);
};

};

},{"./some_promise_array.js":140}],109:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var schedule = _dereq_("./schedule.js");
var Queue = _dereq_("./queue.js");
var errorObj = _dereq_("./util.js").errorObj;
var tryCatch1 = _dereq_("./util.js").tryCatch1;
var process = _dereq_("./global.js").process;

function Async() {
    this._isTickUsed = false;
    this._length = 0;
    this._lateBuffer = new Queue();
    this._functionBuffer = new Queue(25000 * 3);
    var self = this;
    this.consumeFunctionBuffer = function Async$consumeFunctionBuffer() {
        self._consumeFunctionBuffer();
    };
}

Async.prototype.haveItemsQueued = function Async$haveItemsQueued() {
    return this._length > 0;
};

Async.prototype.invokeLater = function Async$invokeLater(fn, receiver, arg) {
    if (process !== void 0 &&
        process.domain != null &&
        !fn.domain) {
        fn = process.domain.bind(fn);
    }
    this._lateBuffer.push(fn, receiver, arg);
    this._queueTick();
};

Async.prototype.invoke = function Async$invoke(fn, receiver, arg) {
    if (process !== void 0 &&
        process.domain != null &&
        !fn.domain) {
        fn = process.domain.bind(fn);
    }
    var functionBuffer = this._functionBuffer;
    functionBuffer.push(fn, receiver, arg);
    this._length = functionBuffer.length();
    this._queueTick();
};

Async.prototype._consumeFunctionBuffer =
function Async$_consumeFunctionBuffer() {
    var functionBuffer = this._functionBuffer;
    while(functionBuffer.length() > 0) {
        var fn = functionBuffer.shift();
        var receiver = functionBuffer.shift();
        var arg = functionBuffer.shift();
        fn.call(receiver, arg);
    }
    this._reset();
    this._consumeLateBuffer();
};

Async.prototype._consumeLateBuffer = function Async$_consumeLateBuffer() {
    var buffer = this._lateBuffer;
    while(buffer.length() > 0) {
        var fn = buffer.shift();
        var receiver = buffer.shift();
        var arg = buffer.shift();
        var res = tryCatch1(fn, receiver, arg);
        if (res === errorObj) {
            this._queueTick();
            if (fn.domain != null) {
                fn.domain.emit("error", res.e);
            }
            else {
                throw res.e;
            }
        }
    }
};

Async.prototype._queueTick = function Async$_queue() {
    if (!this._isTickUsed) {
        schedule(this.consumeFunctionBuffer);
        this._isTickUsed = true;
    }
};

Async.prototype._reset = function Async$_reset() {
    this._isTickUsed = false;
    this._length = 0;
};

module.exports = new Async();

},{"./global.js":122,"./queue.js":133,"./schedule.js":136,"./util.js":144}],110:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var Promise = _dereq_("./promise.js")();
module.exports = Promise;
},{"./promise.js":126}],111:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
Promise.prototype.call = function Promise$call(propertyName) {
    var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}

    return this._then(function(obj) {
            return obj[propertyName].apply(obj, args);
        },
        void 0,
        void 0,
        void 0,
        void 0
   );
};

function Promise$getter(obj) {
    var prop = typeof this === "string"
        ? this
        : ("" + this);
    return obj[prop];
}
Promise.prototype.get = function Promise$get(propertyName) {
    return this._then(
        Promise$getter,
        void 0,
        void 0,
        propertyName,
        void 0
   );
};
};

},{}],112:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var errors = _dereq_("./errors.js");
var async = _dereq_("./async.js");
var CancellationError = errors.CancellationError;

Promise.prototype._cancel = function Promise$_cancel() {
    if (!this.isCancellable()) return this;
    var parent;
    var promiseToReject = this;
    while ((parent = promiseToReject._cancellationParent) !== void 0 &&
        parent.isCancellable()) {
        promiseToReject = parent;
    }
    var err = new CancellationError();
    promiseToReject._attachExtraTrace(err);
    promiseToReject._rejectUnchecked(err);
};

Promise.prototype.cancel = function Promise$cancel() {
    if (!this.isCancellable()) return this;
    async.invokeLater(this._cancel, this, void 0);
    return this;
};

Promise.prototype.cancellable = function Promise$cancellable() {
    if (this._cancellable()) return this;
    this._setCancellable();
    this._cancellationParent = void 0;
    return this;
};

Promise.prototype.uncancellable = function Promise$uncancellable() {
    var ret = new Promise(INTERNAL);
    ret._setTrace(this);
    ret._follow(this);
    ret._unsetCancellable();
    if (this._isBound()) ret._setBoundTo(this._boundTo);
    return ret;
};

Promise.prototype.fork =
function Promise$fork(didFulfill, didReject, didProgress) {
    var ret = this._then(didFulfill, didReject, didProgress,
                         void 0, void 0);

    ret._setCancellable();
    ret._cancellationParent = void 0;
    return ret;
};
};

},{"./async.js":109,"./errors.js":116}],113:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function() {
var inherits = _dereq_("./util.js").inherits;
var defineProperty = _dereq_("./es5.js").defineProperty;

var rignore = new RegExp(
    "\\b(?:[a-zA-Z0-9.]+\\$_\\w+|" +
    "tryCatch(?:1|2|Apply)|new \\w*PromiseArray|" +
    "\\w*PromiseArray\\.\\w*PromiseArray|" +
    "setTimeout|CatchFilter\\$_\\w+|makeNodePromisified|processImmediate|" +
    "process._tickCallback|nextTick|Async\\$\\w+)\\b"
);

var rtraceline = null;
var formatStack = null;

function formatNonError(obj) {
    var str;
    if (typeof obj === "function") {
        str = "[function " +
            (obj.name || "anonymous") +
            "]";
    }
    else {
        str = obj.toString();
        var ruselessToString = /\[object [a-zA-Z0-9$_]+\]/;
        if (ruselessToString.test(str)) {
            try {
                var newStr = JSON.stringify(obj);
                str = newStr;
            }
            catch(e) {

            }
        }
        if (str.length === 0) {
            str = "(empty array)";
        }
    }
    return ("(<" + snip(str) + ">, no stack trace)");
}

function snip(str) {
    var maxChars = 41;
    if (str.length < maxChars) {
        return str;
    }
    return str.substr(0, maxChars - 3) + "...";
}

function CapturedTrace(ignoreUntil, isTopLevel) {
    this.captureStackTrace(CapturedTrace, isTopLevel);

}
inherits(CapturedTrace, Error);

CapturedTrace.prototype.captureStackTrace =
function CapturedTrace$captureStackTrace(ignoreUntil, isTopLevel) {
    captureStackTrace(this, ignoreUntil, isTopLevel);
};

CapturedTrace.possiblyUnhandledRejection =
function CapturedTrace$PossiblyUnhandledRejection(reason) {
    if (typeof console === "object") {
        var message;
        if (typeof reason === "object" || typeof reason === "function") {
            var stack = reason.stack;
            message = "Possibly unhandled " + formatStack(stack, reason);
        }
        else {
            message = "Possibly unhandled " + String(reason);
        }
        if (typeof console.error === "function" ||
            typeof console.error === "object") {
            console.error(message);
        }
        else if (typeof console.log === "function" ||
            typeof console.log === "object") {
            console.log(message);
        }
    }
};

CapturedTrace.combine = function CapturedTrace$Combine(current, prev) {
    var curLast = current.length - 1;
    for (var i = prev.length - 1; i >= 0; --i) {
        var line = prev[i];
        if (current[curLast] === line) {
            current.pop();
            curLast--;
        }
        else {
            break;
        }
    }

    current.push("From previous event:");
    var lines = current.concat(prev);

    var ret = [];

    for (var i = 0, len = lines.length; i < len; ++i) {

        if ((rignore.test(lines[i]) ||
            (i > 0 && !rtraceline.test(lines[i])) &&
            lines[i] !== "From previous event:")
       ) {
            continue;
        }
        ret.push(lines[i]);
    }
    return ret;
};

CapturedTrace.isSupported = function CapturedTrace$IsSupported() {
    return typeof captureStackTrace === "function";
};

var captureStackTrace = (function stackDetection() {
    if (typeof Error.stackTraceLimit === "number" &&
        typeof Error.captureStackTrace === "function") {
        rtraceline = /^\s*at\s*/;
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);


        };
        var captureStackTrace = Error.captureStackTrace;
        return function CapturedTrace$_captureStackTrace(
            receiver, ignoreUntil) {
            captureStackTrace(receiver, ignoreUntil);
        };
    }
    var err = new Error();

    if (typeof err.stack === "string" &&
        typeof "".startsWith === "function" &&
        (err.stack.startsWith("stackDetection@")) &&
        stackDetection.name === "stackDetection") {

        defineProperty(Error, "stackTraceLimit", {
            writable: true,
            enumerable: false,
            configurable: false,
            value: 25
        });
        rtraceline = /@/;
        var rline = /[@\n]/;

        formatStack = function(stack, error) {
            if (typeof stack === "string") {
                return (error.name + ". " + error.message + "\n" + stack);
            }

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return function captureStackTrace(o) {
            var stack = new Error().stack;
            var split = stack.split(rline);
            var len = split.length;
            var ret = "";
            for (var i = 0; i < len; i += 2) {
                ret += split[i];
                ret += "@";
                ret += split[i + 1];
                ret += "\n";
            }
            o.stack = ret;
        };
    }
    else {
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if ((typeof error === "object" ||
                typeof error === "function") &&
                error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return null;
    }
})();

return CapturedTrace;
};

},{"./es5.js":118,"./util.js":144}],114:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(NEXT_FILTER) {
var util = _dereq_("./util.js");
var errors = _dereq_("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;
var keys = _dereq_("./es5.js").keys;
var TypeError = errors.TypeError;

function CatchFilter(instances, callback, promise) {
    this._instances = instances;
    this._callback = callback;
    this._promise = promise;
}

function CatchFilter$_safePredicate(predicate, e) {
    var safeObject = {};
    var retfilter = tryCatch1(predicate, safeObject, e);

    if (retfilter === errorObj) return retfilter;

    var safeKeys = keys(safeObject);
    if (safeKeys.length) {
        errorObj.e = new TypeError(
            "Catch filter must inherit from Error "
          + "or be a simple predicate function");
        return errorObj;
    }
    return retfilter;
}

CatchFilter.prototype.doFilter = function CatchFilter$_doFilter(e) {
    var cb = this._callback;
    var promise = this._promise;
    var boundTo = promise._isBound() ? promise._boundTo : void 0;
    for (var i = 0, len = this._instances.length; i < len; ++i) {
        var item = this._instances[i];
        var itemIsErrorType = item === Error ||
            (item != null && item.prototype instanceof Error);

        if (itemIsErrorType && e instanceof item) {
            var ret = tryCatch1(cb, boundTo, e);
            if (ret === errorObj) {
                NEXT_FILTER.e = ret.e;
                return NEXT_FILTER;
            }
            return ret;
        } else if (typeof item === "function" && !itemIsErrorType) {
            var shouldHandle = CatchFilter$_safePredicate(item, e);
            if (shouldHandle === errorObj) {
                var trace = errors.canAttach(errorObj.e)
                    ? errorObj.e
                    : new Error(errorObj.e + "");
                this._promise._attachExtraTrace(trace);
                e = errorObj.e;
                break;
            } else if (shouldHandle) {
                var ret = tryCatch1(cb, boundTo, e);
                if (ret === errorObj) {
                    NEXT_FILTER.e = ret.e;
                    return NEXT_FILTER;
                }
                return ret;
            }
        }
    }
    NEXT_FILTER.e = e;
    return NEXT_FILTER;
};

return CatchFilter;
};

},{"./errors.js":116,"./es5.js":118,"./util.js":144}],115:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = _dereq_("./util.js");
var isPrimitive = util.isPrimitive;
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;

module.exports = function(Promise) {
var returner = function Promise$_returner() {
    return this;
};
var thrower = function Promise$_thrower() {
    throw this;
};

var wrapper = function Promise$_wrapper(value, action) {
    if (action === 1) {
        return function Promise$_thrower() {
            throw value;
        };
    }
    else if (action === 2) {
        return function Promise$_returner() {
            return value;
        };
    }
};


Promise.prototype["return"] =
Promise.prototype.thenReturn =
function Promise$thenReturn(value) {
    if (wrapsPrimitiveReceiver && isPrimitive(value)) {
        return this._then(
            wrapper(value, 2),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(returner, void 0, void 0, value, void 0);
};

Promise.prototype["throw"] =
Promise.prototype.thenThrow =
function Promise$thenThrow(reason) {
    if (wrapsPrimitiveReceiver && isPrimitive(reason)) {
        return this._then(
            wrapper(reason, 1),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(thrower, void 0, void 0, reason, void 0);
};
};

},{"./util.js":144}],116:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var global = _dereq_("./global.js");
var Objectfreeze = _dereq_("./es5.js").freeze;
var util = _dereq_("./util.js");
var inherits = util.inherits;
var notEnumerableProp = util.notEnumerableProp;
var Error = global.Error;

function markAsOriginatingFromRejection(e) {
    try {
        notEnumerableProp(e, "isAsync", true);
    }
    catch(ignore) {}
}

function originatesFromRejection(e) {
    if (e == null) return false;
    return ((e instanceof RejectionError) ||
        e["isAsync"] === true);
}

function isError(obj) {
    return obj instanceof Error;
}

function canAttach(obj) {
    return isError(obj);
}

function subError(nameProperty, defaultMessage) {
    function SubError(message) {
        if (!(this instanceof SubError)) return new SubError(message);
        this.message = typeof message === "string" ? message : defaultMessage;
        this.name = nameProperty;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
    inherits(SubError, Error);
    return SubError;
}

var TypeError = global.TypeError;
if (typeof TypeError !== "function") {
    TypeError = subError("TypeError", "type error");
}
var RangeError = global.RangeError;
if (typeof RangeError !== "function") {
    RangeError = subError("RangeError", "range error");
}
var CancellationError = subError("CancellationError", "cancellation error");
var TimeoutError = subError("TimeoutError", "timeout error");

function RejectionError(message) {
    this.name = "RejectionError";
    this.message = message;
    this.cause = message;
    this.isAsync = true;

    if (message instanceof Error) {
        this.message = message.message;
        this.stack = message.stack;
    }
    else if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
    }

}
inherits(RejectionError, Error);

var key = "__BluebirdErrorTypes__";
var errorTypes = global[key];
if (!errorTypes) {
    errorTypes = Objectfreeze({
        CancellationError: CancellationError,
        TimeoutError: TimeoutError,
        RejectionError: RejectionError
    });
    notEnumerableProp(global, key, errorTypes);
}

module.exports = {
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    CancellationError: errorTypes.CancellationError,
    RejectionError: errorTypes.RejectionError,
    TimeoutError: errorTypes.TimeoutError,
    originatesFromRejection: originatesFromRejection,
    markAsOriginatingFromRejection: markAsOriginatingFromRejection,
    canAttach: canAttach
};

},{"./es5.js":118,"./global.js":122,"./util.js":144}],117:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var TypeError = _dereq_('./errors.js').TypeError;

function apiRejection(msg) {
    var error = new TypeError(msg);
    var ret = Promise.rejected(error);
    var parent = ret._peekContext();
    if (parent != null) {
        parent._attachExtraTrace(error);
    }
    return ret;
}

return apiRejection;
};

},{"./errors.js":116}],118:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
var isES5 = (function(){
    "use strict";
    return this === void 0;
})();

if (isES5) {
    module.exports = {
        freeze: Object.freeze,
        defineProperty: Object.defineProperty,
        keys: Object.keys,
        getPrototypeOf: Object.getPrototypeOf,
        isArray: Array.isArray,
        isES5: isES5
    };
}

else {
    var has = {}.hasOwnProperty;
    var str = {}.toString;
    var proto = {}.constructor.prototype;

    var ObjectKeys = function ObjectKeys(o) {
        var ret = [];
        for (var key in o) {
            if (has.call(o, key)) {
                ret.push(key);
            }
        }
        return ret;
    }

    var ObjectDefineProperty = function ObjectDefineProperty(o, key, desc) {
        o[key] = desc.value;
        return o;
    }

    var ObjectFreeze = function ObjectFreeze(obj) {
        return obj;
    }

    var ObjectGetPrototypeOf = function ObjectGetPrototypeOf(obj) {
        try {
            return Object(obj).constructor.prototype;
        }
        catch (e) {
            return proto;
        }
    }

    var ArrayIsArray = function ArrayIsArray(obj) {
        try {
            return str.call(obj) === "[object Array]";
        }
        catch(e) {
            return false;
        }
    }

    module.exports = {
        isArray: ArrayIsArray,
        keys: ObjectKeys,
        defineProperty: ObjectDefineProperty,
        freeze: ObjectFreeze,
        getPrototypeOf: ObjectGetPrototypeOf,
        isES5: isES5
    };
}

},{}],119:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var isArray = _dereq_("./util.js").isArray;

function Promise$_filter(booleans) {
    var values = this instanceof Promise ? this._settledValue : this;
    var len = values.length;
    var ret = new Array(len);
    var j = 0;

    for (var i = 0; i < len; ++i) {
        if (booleans[i]) ret[j++] = values[i];

    }
    ret.length = j;
    return ret;
}

var ref = {ref: null};
Promise.filter = function Promise$Filter(promises, fn) {
    return Promise.map(promises, fn, ref)
                  ._then(Promise$_filter, void 0, void 0, ref.ref, void 0);
};

Promise.prototype.filter = function Promise$filter(fn) {
    return this.map(fn, ref)
               ._then(Promise$_filter, void 0, void 0, ref.ref, void 0);
};
};

},{"./util.js":144}],120:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, NEXT_FILTER) {
var util = _dereq_("./util.js");
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;
var isPrimitive = util.isPrimitive;
var thrower = util.thrower;


function returnThis() {
    return this;
}
function throwThis() {
    throw this;
}
function return$(r) {
    return function Promise$_returner() {
        return r;
    };
}
function throw$(r) {
    return function Promise$_thrower() {
        throw r;
    };
}
function promisedFinally(ret, reasonOrValue, isFulfilled) {
    var then;
    if (wrapsPrimitiveReceiver && isPrimitive(reasonOrValue)) {
        then = isFulfilled ? return$(reasonOrValue) : throw$(reasonOrValue);
    }
    else {
        then = isFulfilled ? returnThis : throwThis;
    }
    return ret._then(then, thrower, void 0, reasonOrValue, void 0);
}

function finallyHandler(reasonOrValue) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo)
                    : handler();

    if (ret !== void 0) {
        var maybePromise = Promise._cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, reasonOrValue,
                                    promise.isFulfilled());
        }
    }

    if (promise.isRejected()) {
        NEXT_FILTER.e = reasonOrValue;
        return NEXT_FILTER;
    }
    else {
        return reasonOrValue;
    }
}

function tapHandler(value) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo, value)
                    : handler(value);

    if (ret !== void 0) {
        var maybePromise = Promise._cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, value, true);
        }
    }
    return value;
}

Promise.prototype._passThroughHandler =
function Promise$_passThroughHandler(handler, isFinally) {
    if (typeof handler !== "function") return this.then();

    var promiseAndHandler = {
        promise: this,
        handler: handler
    };

    return this._then(
            isFinally ? finallyHandler : tapHandler,
            isFinally ? finallyHandler : void 0, void 0,
            promiseAndHandler, void 0);
};

Promise.prototype.lastly =
Promise.prototype["finally"] = function Promise$finally(handler) {
    return this._passThroughHandler(handler, true);
};

Promise.prototype.tap = function Promise$tap(handler) {
    return this._passThroughHandler(handler, false);
};
};

},{"./util.js":144}],121:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, apiRejection, INTERNAL) {
var PromiseSpawn = _dereq_("./promise_spawn.js")(Promise, INTERNAL);
var errors = _dereq_("./errors.js");
var TypeError = errors.TypeError;
var deprecated = _dereq_("./util.js").deprecated;

Promise.coroutine = function Promise$Coroutine(generatorFunction) {
    if (typeof generatorFunction !== "function") {
        throw new TypeError("generatorFunction must be a function");
    }
    var PromiseSpawn$ = PromiseSpawn;
    return function () {
        var generator = generatorFunction.apply(this, arguments);
        var spawn = new PromiseSpawn$(void 0, void 0);
        spawn._generator = generator;
        spawn._next(void 0);
        return spawn.promise();
    };
};

Promise.coroutine.addYieldHandler = PromiseSpawn.addYieldHandler;

Promise.spawn = function Promise$Spawn(generatorFunction) {
    deprecated("Promise.spawn is deprecated. Use Promise.coroutine instead.");
    if (typeof generatorFunction !== "function") {
        return apiRejection("generatorFunction must be a function");
    }
    var spawn = new PromiseSpawn(generatorFunction, this);
    var ret = spawn.promise();
    spawn._run(Promise.spawn);
    return ret;
};
};

},{"./errors.js":116,"./promise_spawn.js":129,"./util.js":144}],122:[function(_dereq_,module,exports){
(function (global){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
module.exports = (function() {
    if (this !== void 0) return this;
    try {return global;}
    catch(e) {}
    try {return window;}
    catch(e) {}
    try {return self;}
    catch(e) {}
})();

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],123:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, INTERNAL, apiRejection) {

var all = Promise.all;
var util = _dereq_("./util.js");
var canAttach = _dereq_("./errors.js").canAttach;
var isArray = util.isArray;
var _cast = Promise._cast;

function unpack(values) {
    return Promise$_Map(values, this[0], this[1], this[2]);
}

function Promise$_Map(promises, fn, useBound, ref) {
    if (typeof fn !== "function") {
        return apiRejection("fn must be a function");
    }

    var receiver = void 0;
    if (useBound === true) {
        if (promises._isBound()) {
            receiver = promises._boundTo;
        }
    }
    else if (useBound !== false) {
        receiver = useBound;
    }

    var shouldUnwrapItems = ref !== void 0;
    if (shouldUnwrapItems) ref.ref = promises;

    if (promises instanceof Promise) {
        var pack = [fn, receiver, ref];
        return promises._then(unpack, void 0, void 0, pack, void 0);
    }
    else if (!isArray(promises)) {
        return apiRejection("expecting an array, a promise or a thenable");
    }

    var promise = new Promise(INTERNAL);
    if (receiver !== void 0) promise._setBoundTo(receiver);
    promise._setTrace(void 0);

    var mapping = new Mapping(promise,
                                fn,
                                promises,
                                receiver,
                                shouldUnwrapItems);
    mapping.init();
    return promise;
}

var pending = {};
function Mapping(promise, callback, items, receiver, shouldUnwrapItems) {
    this.shouldUnwrapItems = shouldUnwrapItems;
    this.index = 0;
    this.items = items;
    this.callback = callback;
    this.receiver = receiver;
    this.promise = promise;
    this.result = new Array(items.length);
}
util.inherits(Mapping, PromiseArray);

Mapping.prototype.init = function Mapping$init() {
    var items = this.items;
    var len = items.length;
    var result = this.result;
    var isRejected = false;
    for (var i = 0; i < len; ++i) {
        var maybePromise = _cast(items[i], void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                result[i] = pending;
                maybePromise._proxyPromiseArray(this, i);
            }
            else if (maybePromise.isFulfilled()) {
                result[i] = maybePromise.value();
            }
            else {
                maybePromise._unsetRejectionIsUnhandled();
                if (!isRejected) {
                    this.reject(maybePromise.reason());
                    isRejected = true;
                }
            }
        }
        else {
            result[i] = maybePromise;
        }
    }
    if (!isRejected) this.iterate();
};

Mapping.prototype.isResolved = function Mapping$isResolved() {
    return this.promise === null;
};

Mapping.prototype._promiseProgressed =
function Mapping$_promiseProgressed(value) {
    if (this.isResolved()) return;
    this.promise._progress(value);
};

Mapping.prototype._promiseFulfilled =
function Mapping$_promiseFulfilled(value, index) {
    if (this.isResolved()) return;
    this.result[index] = value;
    if (this.shouldUnwrapItems) this.items[index] = value;
    if (this.index === index) this.iterate();
};

Mapping.prototype._promiseRejected =
function Mapping$_promiseRejected(reason) {
    this.reject(reason);
};

Mapping.prototype.reject = function Mapping$reject(reason) {
    if (this.isResolved()) return;
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this.promise._attachExtraTrace(trace);
    this.promise._reject(reason, trace);
};

Mapping.prototype.iterate = function Mapping$iterate() {
    var i = this.index;
    var items = this.items;
    var result = this.result;
    var len = items.length;
    var result = this.result;
    var receiver = this.receiver;
    var callback = this.callback;

    for (; i < len; ++i) {
        var value = result[i];
        if (value === pending) {
            this.index = i;
            return;
        }
        try { result[i] = callback.call(receiver, value, i, len); }
        catch (e) { return this.reject(e); }
    }
    this.promise._follow(all(result));
    this.items = this.result = this.callback = this.promise = null;
};

Promise.prototype.map = function Promise$map(fn, ref) {
    return Promise$_Map(this, fn, true, ref);
};

Promise.map = function Promise$Map(promises, fn, ref) {
    return Promise$_Map(promises, fn, false, ref);
};
};

},{"./errors.js":116,"./util.js":144}],124:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var tryCatch2 = util.tryCatch2;
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

function thrower(r) {
    throw r;
}

function Promise$_successAdapter(val, receiver) {
    var nodeback = this;
    var ret = val === void 0
        ? tryCatch1(nodeback, receiver, null)
        : tryCatch2(nodeback, receiver, null, val);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}
function Promise$_errorAdapter(reason, receiver) {
    var nodeback = this;
    var ret = tryCatch1(nodeback, receiver, reason);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}

Promise.prototype.nodeify = function Promise$nodeify(nodeback) {
    if (typeof nodeback == "function") {
        this._then(
            Promise$_successAdapter,
            Promise$_errorAdapter,
            void 0,
            nodeback,
            this._isBound() ? this._boundTo : null
        );
    }
    return this;
};
};

},{"./async.js":109,"./util.js":144}],125:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, isPromiseArrayProxy) {
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var errors = _dereq_("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

Promise.prototype.progressed = function Promise$progressed(handler) {
    return this._then(void 0, void 0, handler, void 0, void 0);
};

Promise.prototype._progress = function Promise$_progress(progressValue) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._progressUnchecked(progressValue);

};

Promise.prototype._progressHandlerAt =
function Promise$_progressHandlerAt(index) {
    if (index === 0) return this._progressHandler0;
    return this[index + 2 - 5];
};

Promise.prototype._doProgressWith =
function Promise$_doProgressWith(progression) {
    var progressValue = progression.value;
    var handler = progression.handler;
    var promise = progression.promise;
    var receiver = progression.receiver;

    this._pushContext();
    var ret = tryCatch1(handler, receiver, progressValue);
    this._popContext();

    if (ret === errorObj) {
        if (ret.e != null &&
            ret.e.name !== "StopProgressPropagation") {
            var trace = errors.canAttach(ret.e)
                ? ret.e : new Error(ret.e + "");
            promise._attachExtraTrace(trace);
            promise._progress(ret.e);
        }
    }
    else if (ret instanceof Promise) {
        ret._then(promise._progress, null, null, promise, void 0);
    }
    else {
        promise._progress(ret);
    }
};


Promise.prototype._progressUnchecked =
function Promise$_progressUnchecked(progressValue) {
    if (!this.isPending()) return;
    var len = this._length();
    var progress = this._progress;
    for (var i = 0; i < len; i += 5) {
        var handler = this._progressHandlerAt(i);
        var promise = this._promiseAt(i);
        if (!(promise instanceof Promise)) {
            var receiver = this._receiverAt(i);
            if (typeof handler === "function") {
                handler.call(receiver, progressValue, promise);
            }
            else if (receiver instanceof Promise && receiver._isProxied()) {
                receiver._progressUnchecked(progressValue);
            }
            else if (isPromiseArrayProxy(receiver, promise)) {
                receiver._promiseProgressed(progressValue, promise);
            }
            continue;
        }

        if (typeof handler === "function") {
            async.invoke(this._doProgressWith, this, {
                handler: handler,
                promise: promise,
                receiver: this._receiverAt(i),
                value: progressValue
            });
        }
        else {
            async.invoke(progress, promise, progressValue);
        }
    }
};
};

},{"./async.js":109,"./errors.js":116,"./util.js":144}],126:[function(_dereq_,module,exports){
(function (process){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function() {
var global = _dereq_("./global.js");
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var errors = _dereq_("./errors.js");

var INTERNAL = function(){};
var APPLY = {};
var NEXT_FILTER = {e: null};

var PromiseArray = _dereq_("./promise_array.js")(Promise, INTERNAL);
var CapturedTrace = _dereq_("./captured_trace.js")();
var CatchFilter = _dereq_("./catch_filter.js")(NEXT_FILTER);
var PromiseResolver = _dereq_("./promise_resolver.js");

var isArray = util.isArray;

var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var tryCatch2 = util.tryCatch2;
var tryCatchApply = util.tryCatchApply;
var RangeError = errors.RangeError;
var TypeError = errors.TypeError;
var CancellationError = errors.CancellationError;
var TimeoutError = errors.TimeoutError;
var RejectionError = errors.RejectionError;
var originatesFromRejection = errors.originatesFromRejection;
var markAsOriginatingFromRejection = errors.markAsOriginatingFromRejection;
var canAttach = errors.canAttach;
var thrower = util.thrower;
var apiRejection = _dereq_("./errors_api_rejection")(Promise);


var makeSelfResolutionError = function Promise$_makeSelfResolutionError() {
    return new TypeError("circular promise resolution chain");
};

function isPromise(obj) {
    if (obj === void 0) return false;
    return obj instanceof Promise;
}

function isPromiseArrayProxy(receiver, promiseSlotValue) {
    if (receiver instanceof PromiseArray) {
        return promiseSlotValue >= 0;
    }
    return false;
}

function Promise(resolver) {
    if (typeof resolver !== "function") {
        throw new TypeError("the promise constructor requires a resolver function");
    }
    if (this.constructor !== Promise) {
        throw new TypeError("the promise constructor cannot be invoked directly");
    }
    this._bitField = 0;
    this._fulfillmentHandler0 = void 0;
    this._rejectionHandler0 = void 0;
    this._promise0 = void 0;
    this._receiver0 = void 0;
    this._settledValue = void 0;
    this._boundTo = void 0;
    if (resolver !== INTERNAL) this._resolveFromResolver(resolver);
}

Promise.prototype.bind = function Promise$bind(thisArg) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(this);
    ret._follow(this);
    ret._setBoundTo(thisArg);
    if (this._cancellable()) {
        ret._setCancellable();
        ret._cancellationParent = this;
    }
    return ret;
};

Promise.prototype.toString = function Promise$toString() {
    return "[object Promise]";
};

Promise.prototype.caught = Promise.prototype["catch"] =
function Promise$catch(fn) {
    var len = arguments.length;
    if (len > 1) {
        var catchInstances = new Array(len - 1),
            j = 0, i;
        for (i = 0; i < len - 1; ++i) {
            var item = arguments[i];
            if (typeof item === "function") {
                catchInstances[j++] = item;
            }
            else {
                var catchFilterTypeError =
                    new TypeError(
                        "A catch filter must be an error constructor "
                        + "or a filter function");

                this._attachExtraTrace(catchFilterTypeError);
                async.invoke(this._reject, this, catchFilterTypeError);
                return;
            }
        }
        catchInstances.length = j;
        fn = arguments[i];

        this._resetTrace();
        var catchFilter = new CatchFilter(catchInstances, fn, this);
        return this._then(void 0, catchFilter.doFilter, void 0,
            catchFilter, void 0);
    }
    return this._then(void 0, fn, void 0, void 0, void 0);
};

Promise.prototype.then =
function Promise$then(didFulfill, didReject, didProgress) {
    return this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
};


Promise.prototype.done =
function Promise$done(didFulfill, didReject, didProgress) {
    var promise = this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
    promise._setIsFinal();
};

Promise.prototype.spread = function Promise$spread(didFulfill, didReject) {
    return this._then(didFulfill, didReject, void 0,
        APPLY, void 0);
};

Promise.prototype.isCancellable = function Promise$isCancellable() {
    return !this.isResolved() &&
        this._cancellable();
};

Promise.prototype.toJSON = function Promise$toJSON() {
    var ret = {
        isFulfilled: false,
        isRejected: false,
        fulfillmentValue: void 0,
        rejectionReason: void 0
    };
    if (this.isFulfilled()) {
        ret.fulfillmentValue = this._settledValue;
        ret.isFulfilled = true;
    }
    else if (this.isRejected()) {
        ret.rejectionReason = this._settledValue;
        ret.isRejected = true;
    }
    return ret;
};

Promise.prototype.all = function Promise$all() {
    return Promise$_all(this, true);
};


Promise.is = isPromise;

function Promise$_all(promises, useBound) {
    return Promise$_CreatePromiseArray(
        promises,
        PromiseArray,
        useBound === true && promises._isBound()
            ? promises._boundTo
            : void 0
   ).promise();
}
Promise.all = function Promise$All(promises) {
    return Promise$_all(promises, false);
};

Promise.join = function Promise$Join() {
    var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
    return Promise$_CreatePromiseArray(args, PromiseArray, void 0).promise();
};

Promise.resolve = Promise.fulfilled =
function Promise$Resolve(value) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    if (ret._tryFollow(value)) {
        return ret;
    }
    ret._cleanValues();
    ret._setFulfilled();
    ret._settledValue = value;
    return ret;
};

Promise.reject = Promise.rejected = function Promise$Reject(reason) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    markAsOriginatingFromRejection(reason);
    ret._cleanValues();
    ret._setRejected();
    ret._settledValue = reason;
    if (!canAttach(reason)) {
        var trace = new Error(reason + "");
        ret._setCarriedStackTrace(trace);
    }
    ret._ensurePossibleRejectionHandled();
    return ret;
};

Promise.prototype.error = function Promise$_error(fn) {
    return this.caught(originatesFromRejection, fn);
};

Promise.prototype._resolveFromSyncValue =
function Promise$_resolveFromSyncValue(value) {
    if (value === errorObj) {
        this._cleanValues();
        this._setRejected();
        this._settledValue = value.e;
        this._ensurePossibleRejectionHandled();
    }
    else {
        var maybePromise = Promise._cast(value, void 0);
        if (maybePromise instanceof Promise) {
            this._follow(maybePromise);
        }
        else {
            this._cleanValues();
            this._setFulfilled();
            this._settledValue = value;
        }
    }
};

Promise.method = function Promise$_Method(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    return function Promise$_method() {
        var value;
        switch(arguments.length) {
        case 0: value = tryCatch1(fn, this, void 0); break;
        case 1: value = tryCatch1(fn, this, arguments[0]); break;
        case 2: value = tryCatch2(fn, this, arguments[0], arguments[1]); break;
        default:
            var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
            value = tryCatchApply(fn, args, this); break;
        }
        var ret = new Promise(INTERNAL);
        ret._setTrace(void 0);
        ret._resolveFromSyncValue(value);
        return ret;
    };
};

Promise.attempt = Promise["try"] = function Promise$_Try(fn, args, ctx) {
    if (typeof fn !== "function") {
        return apiRejection("fn must be a function");
    }
    var value = isArray(args)
        ? tryCatchApply(fn, args, ctx)
        : tryCatch1(fn, ctx, args);

    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    ret._resolveFromSyncValue(value);
    return ret;
};

Promise.defer = Promise.pending = function Promise$Defer() {
    var promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    return new PromiseResolver(promise);
};

Promise.bind = function Promise$Bind(thisArg) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    ret._setFulfilled();
    ret._setBoundTo(thisArg);
    return ret;
};

Promise.cast = function Promise$_Cast(obj) {
    var ret = Promise._cast(obj, void 0);
    if (!(ret instanceof Promise)) {
        return Promise.resolve(ret);
    }
    return ret;
};

Promise.onPossiblyUnhandledRejection =
function Promise$OnPossiblyUnhandledRejection(fn) {
        CapturedTrace.possiblyUnhandledRejection = typeof fn === "function"
                                                    ? fn : void 0;
};

var unhandledRejectionHandled;
Promise.onUnhandledRejectionHandled =
function Promise$onUnhandledRejectionHandled(fn) {
    unhandledRejectionHandled = typeof fn === "function" ? fn : void 0;
};

var debugging = false || !!(
    typeof process !== "undefined" &&
    typeof process.execPath === "string" &&
    typeof process.env === "object" &&
    (process.env["BLUEBIRD_DEBUG"] ||
        process.env["NODE_ENV"] === "development")
);


Promise.longStackTraces = function Promise$LongStackTraces() {
    if (async.haveItemsQueued() &&
        debugging === false
   ) {
        throw new Error("cannot enable long stack traces after promises have been created");
    }
    debugging = CapturedTrace.isSupported();
};

Promise.hasLongStackTraces = function Promise$HasLongStackTraces() {
    return debugging && CapturedTrace.isSupported();
};

Promise.prototype._setProxyHandlers =
function Promise$_setProxyHandlers(receiver, promiseSlotValue) {
    var index = this._length();

    if (index >= 524287 - 5) {
        index = 0;
        this._setLength(0);
    }
    if (index === 0) {
        this._promise0 = promiseSlotValue;
        this._receiver0 = receiver;
    }
    else {
        var i = index - 5;
        this[i + 3] = promiseSlotValue;
        this[i + 4] = receiver;
        this[i + 0] =
        this[i + 1] =
        this[i + 2] = void 0;
    }
    this._setLength(index + 5);
};

Promise.prototype._proxyPromiseArray =
function Promise$_proxyPromiseArray(promiseArray, index) {
    this._setProxyHandlers(promiseArray, index);
};

Promise.prototype._proxyPromise = function Promise$_proxyPromise(promise) {
    promise._setProxied();
    this._setProxyHandlers(promise, -1);
};

Promise.prototype._then =
function Promise$_then(
    didFulfill,
    didReject,
    didProgress,
    receiver,
    internalData
) {
    var haveInternalData = internalData !== void 0;
    var ret = haveInternalData ? internalData : new Promise(INTERNAL);

    if (debugging && !haveInternalData) {
        var haveSameContext = this._peekContext() === this._traceParent;
        ret._traceParent = haveSameContext ? this._traceParent : this;
        ret._setTrace(this);
    }

    if (!haveInternalData && this._isBound()) {
        ret._setBoundTo(this._boundTo);
    }

    var callbackIndex =
        this._addCallbacks(didFulfill, didReject, didProgress, ret, receiver);

    if (!haveInternalData && this._cancellable()) {
        ret._setCancellable();
        ret._cancellationParent = this;
    }

    if (this.isResolved()) {
        async.invoke(this._queueSettleAt, this, callbackIndex);
    }

    return ret;
};

Promise.prototype._length = function Promise$_length() {
    return this._bitField & 524287;
};

Promise.prototype._isFollowingOrFulfilledOrRejected =
function Promise$_isFollowingOrFulfilledOrRejected() {
    return (this._bitField & 939524096) > 0;
};

Promise.prototype._isFollowing = function Promise$_isFollowing() {
    return (this._bitField & 536870912) === 536870912;
};

Promise.prototype._setLength = function Promise$_setLength(len) {
    this._bitField = (this._bitField & -524288) |
        (len & 524287);
};

Promise.prototype._setFulfilled = function Promise$_setFulfilled() {
    this._bitField = this._bitField | 268435456;
};

Promise.prototype._setRejected = function Promise$_setRejected() {
    this._bitField = this._bitField | 134217728;
};

Promise.prototype._setFollowing = function Promise$_setFollowing() {
    this._bitField = this._bitField | 536870912;
};

Promise.prototype._setIsFinal = function Promise$_setIsFinal() {
    this._bitField = this._bitField | 33554432;
};

Promise.prototype._isFinal = function Promise$_isFinal() {
    return (this._bitField & 33554432) > 0;
};

Promise.prototype._cancellable = function Promise$_cancellable() {
    return (this._bitField & 67108864) > 0;
};

Promise.prototype._setCancellable = function Promise$_setCancellable() {
    this._bitField = this._bitField | 67108864;
};

Promise.prototype._unsetCancellable = function Promise$_unsetCancellable() {
    this._bitField = this._bitField & (~67108864);
};

Promise.prototype._setRejectionIsUnhandled =
function Promise$_setRejectionIsUnhandled() {
    this._bitField = this._bitField | 2097152;
};

Promise.prototype._unsetRejectionIsUnhandled =
function Promise$_unsetRejectionIsUnhandled() {
    this._bitField = this._bitField & (~2097152);
    if (this._isUnhandledRejectionNotified()) {
        this._unsetUnhandledRejectionIsNotified();
        this._notifyUnhandledRejectionIsHandled();
    }
};

Promise.prototype._isRejectionUnhandled =
function Promise$_isRejectionUnhandled() {
    return (this._bitField & 2097152) > 0;
};

Promise.prototype._setUnhandledRejectionIsNotified =
function Promise$_setUnhandledRejectionIsNotified() {
    this._bitField = this._bitField | 524288;
};

Promise.prototype._unsetUnhandledRejectionIsNotified =
function Promise$_unsetUnhandledRejectionIsNotified() {
    this._bitField = this._bitField & (~524288);
};

Promise.prototype._isUnhandledRejectionNotified =
function Promise$_isUnhandledRejectionNotified() {
    return (this._bitField & 524288) > 0;
};

Promise.prototype._setCarriedStackTrace =
function Promise$_setCarriedStackTrace(capturedTrace) {
    this._bitField = this._bitField | 1048576;
    this._fulfillmentHandler0 = capturedTrace;
};

Promise.prototype._unsetCarriedStackTrace =
function Promise$_unsetCarriedStackTrace() {
    this._bitField = this._bitField & (~1048576);
    this._fulfillmentHandler0 = void 0;
};

Promise.prototype._isCarryingStackTrace =
function Promise$_isCarryingStackTrace() {
    return (this._bitField & 1048576) > 0;
};

Promise.prototype._getCarriedStackTrace =
function Promise$_getCarriedStackTrace() {
    return this._isCarryingStackTrace()
        ? this._fulfillmentHandler0
        : void 0;
};

Promise.prototype._receiverAt = function Promise$_receiverAt(index) {
    var ret;
    if (index === 0) {
        ret = this._receiver0;
    }
    else {
        ret = this[index + 4 - 5];
    }
    if (this._isBound() && ret === void 0) {
        return this._boundTo;
    }
    return ret;
};

Promise.prototype._promiseAt = function Promise$_promiseAt(index) {
    if (index === 0) return this._promise0;
    return this[index + 3 - 5];
};

Promise.prototype._fulfillmentHandlerAt =
function Promise$_fulfillmentHandlerAt(index) {
    if (index === 0) return this._fulfillmentHandler0;
    return this[index + 0 - 5];
};

Promise.prototype._rejectionHandlerAt =
function Promise$_rejectionHandlerAt(index) {
    if (index === 0) return this._rejectionHandler0;
    return this[index + 1 - 5];
};

Promise.prototype._unsetAt = function Promise$_unsetAt(index) {
     if (index === 0) {
        this._rejectionHandler0 =
        this._progressHandler0 =
        this._promise0 =
        this._receiver0 = void 0;
        if (!this._isCarryingStackTrace()) {
            this._fulfillmentHandler0 = void 0;
        }
    }
    else {
        this[index - 5 + 0] =
        this[index - 5 + 1] =
        this[index - 5 + 2] =
        this[index - 5 + 3] =
        this[index - 5 + 4] = void 0;
    }
};

Promise.prototype._resolveFromResolver =
function Promise$_resolveFromResolver(resolver) {
    var promise = this;
    this._setTrace(void 0);
    this._pushContext();

    function Promise$_resolver(val) {
        if (promise._tryFollow(val)) {
            return;
        }
        promise._fulfill(val);
    }
    function Promise$_rejecter(val) {
        var trace = canAttach(val) ? val : new Error(val + "");
        promise._attachExtraTrace(trace);
        markAsOriginatingFromRejection(val);
        promise._reject(val, trace === val ? void 0 : trace);
    }
    var r = tryCatch2(resolver, void 0, Promise$_resolver, Promise$_rejecter);
    this._popContext();

    if (r !== void 0 && r === errorObj) {
        var e = r.e;
        var trace = canAttach(e) ? e : new Error(e + "");
        promise._reject(e, trace);
    }
};

Promise.prototype._addCallbacks = function Promise$_addCallbacks(
    fulfill,
    reject,
    progress,
    promise,
    receiver
) {
    var index = this._length();

    if (index >= 524287 - 5) {
        index = 0;
        this._setLength(0);
    }

    if (index === 0) {
        this._promise0 = promise;
        if (receiver !== void 0) this._receiver0 = receiver;
        if (typeof fulfill === "function" && !this._isCarryingStackTrace())
            this._fulfillmentHandler0 = fulfill;
        if (typeof reject === "function") this._rejectionHandler0 = reject;
        if (typeof progress === "function") this._progressHandler0 = progress;
    }
    else {
        var i = index - 5;
        this[i + 3] = promise;
        this[i + 4] = receiver;
        this[i + 0] = typeof fulfill === "function"
                                            ? fulfill : void 0;
        this[i + 1] = typeof reject === "function"
                                            ? reject : void 0;
        this[i + 2] = typeof progress === "function"
                                            ? progress : void 0;
    }
    this._setLength(index + 5);
    return index;
};



Promise.prototype._setBoundTo = function Promise$_setBoundTo(obj) {
    if (obj !== void 0) {
        this._bitField = this._bitField | 8388608;
        this._boundTo = obj;
    }
    else {
        this._bitField = this._bitField & (~8388608);
    }
};

Promise.prototype._isBound = function Promise$_isBound() {
    return (this._bitField & 8388608) === 8388608;
};

Promise.prototype._spreadSlowCase =
function Promise$_spreadSlowCase(targetFn, promise, values, boundTo) {
    var promiseForAll =
            Promise$_CreatePromiseArray
                (values, PromiseArray, boundTo)
            .promise()
            ._then(function() {
                return targetFn.apply(boundTo, arguments);
            }, void 0, void 0, APPLY, void 0);

    promise._follow(promiseForAll);
};

Promise.prototype._callSpread =
function Promise$_callSpread(handler, promise, value, localDebugging) {
    var boundTo = this._isBound() ? this._boundTo : void 0;
    if (isArray(value)) {
        for (var i = 0, len = value.length; i < len; ++i) {
            if (isPromise(Promise._cast(value[i], void 0))) {
                this._spreadSlowCase(handler, promise, value, boundTo);
                return;
            }
        }
    }
    if (localDebugging) promise._pushContext();
    return tryCatchApply(handler, value, boundTo);
};

Promise.prototype._callHandler =
function Promise$_callHandler(
    handler, receiver, promise, value, localDebugging) {
    var x;
    if (receiver === APPLY && !this.isRejected()) {
        x = this._callSpread(handler, promise, value, localDebugging);
    }
    else {
        if (localDebugging) promise._pushContext();
        x = tryCatch1(handler, receiver, value);
    }
    if (localDebugging) promise._popContext();
    return x;
};

Promise.prototype._settlePromiseFromHandler =
function Promise$_settlePromiseFromHandler(
    handler, receiver, value, promise
) {
    if (!isPromise(promise)) {
        handler.call(receiver, value, promise);
        return;
    }

    var localDebugging = debugging;
    var x = this._callHandler(handler, receiver,
                                promise, value, localDebugging);

    if (promise._isFollowing()) return;

    if (x === errorObj || x === promise || x === NEXT_FILTER) {
        var err = x === promise
                    ? makeSelfResolutionError()
                    : x.e;
        var trace = canAttach(err) ? err : new Error(err + "");
        if (x !== NEXT_FILTER) promise._attachExtraTrace(trace);
        promise._rejectUnchecked(err, trace);
    }
    else {
        var castValue = Promise._cast(x, promise);
        if (isPromise(castValue)) {
            if (castValue.isRejected() &&
                !castValue._isCarryingStackTrace() &&
                !canAttach(castValue._settledValue)) {
                var trace = new Error(castValue._settledValue + "");
                promise._attachExtraTrace(trace);
                castValue._setCarriedStackTrace(trace);
            }
            promise._follow(castValue);
            if (castValue._cancellable()) {
                promise._cancellationParent = castValue;
                promise._setCancellable();
            }
        }
        else {
            promise._fulfillUnchecked(x);
        }
    }
};

Promise.prototype._follow =
function Promise$_follow(promise) {
    this._setFollowing();

    if (promise.isPending()) {
        if (promise._cancellable() ) {
            this._cancellationParent = promise;
            this._setCancellable();
        }
        promise._proxyPromise(this);
    }
    else if (promise.isFulfilled()) {
        this._fulfillUnchecked(promise._settledValue);
    }
    else {
        this._rejectUnchecked(promise._settledValue,
            promise._getCarriedStackTrace());
    }

    if (promise._isRejectionUnhandled()) promise._unsetRejectionIsUnhandled();

    if (debugging &&
        promise._traceParent == null) {
        promise._traceParent = this;
    }
};

Promise.prototype._tryFollow =
function Promise$_tryFollow(value) {
    if (this._isFollowingOrFulfilledOrRejected() ||
        value === this) {
        return false;
    }
    var maybePromise = Promise._cast(value, void 0);
    if (!isPromise(maybePromise)) {
        return false;
    }
    this._follow(maybePromise);
    return true;
};

Promise.prototype._resetTrace = function Promise$_resetTrace() {
    if (debugging) {
        this._trace = new CapturedTrace(this._peekContext() === void 0);
    }
};

Promise.prototype._setTrace = function Promise$_setTrace(parent) {
    if (debugging) {
        var context = this._peekContext();
        this._traceParent = context;
        var isTopLevel = context === void 0;
        if (parent !== void 0 &&
            parent._traceParent === context) {
            this._trace = parent._trace;
        }
        else {
            this._trace = new CapturedTrace(isTopLevel);
        }
    }
    return this;
};

Promise.prototype._attachExtraTrace =
function Promise$_attachExtraTrace(error) {
    if (debugging) {
        var promise = this;
        var stack = error.stack;
        stack = typeof stack === "string"
            ? stack.split("\n") : [];
        var headerLineCount = 1;

        while(promise != null &&
            promise._trace != null) {
            stack = CapturedTrace.combine(
                stack,
                promise._trace.stack.split("\n")
           );
            promise = promise._traceParent;
        }

        var max = Error.stackTraceLimit + headerLineCount;
        var len = stack.length;
        if (len  > max) {
            stack.length = max;
        }
        if (stack.length <= headerLineCount) {
            error.stack = "(No stack trace)";
        }
        else {
            error.stack = stack.join("\n");
        }
    }
};

Promise.prototype._cleanValues = function Promise$_cleanValues() {
    if (this._cancellable()) {
        this._cancellationParent = void 0;
    }
};

Promise.prototype._fulfill = function Promise$_fulfill(value) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._fulfillUnchecked(value);
};

Promise.prototype._reject =
function Promise$_reject(reason, carriedStackTrace) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._rejectUnchecked(reason, carriedStackTrace);
};

Promise.prototype._settlePromiseAt = function Promise$_settlePromiseAt(index) {
    var handler = this.isFulfilled()
        ? this._fulfillmentHandlerAt(index)
        : this._rejectionHandlerAt(index);

    var value = this._settledValue;
    var receiver = this._receiverAt(index);
    var promise = this._promiseAt(index);

    if (typeof handler === "function") {
        this._settlePromiseFromHandler(handler, receiver, value, promise);
    }
    else {
        var done = false;
        var isFulfilled = this.isFulfilled();
        if (receiver !== void 0) {
            if (receiver instanceof Promise &&
                receiver._isProxied()) {
                receiver._unsetProxied();

                if (isFulfilled) receiver._fulfillUnchecked(value);
                else receiver._rejectUnchecked(value,
                    this._getCarriedStackTrace());
                done = true;
            }
            else if (isPromiseArrayProxy(receiver, promise)) {
                if (isFulfilled) receiver._promiseFulfilled(value, promise);
                else receiver._promiseRejected(value, promise);
                done = true;
            }
        }

        if (!done) {
            if (isFulfilled) promise._fulfill(value);
            else promise._reject(value, this._getCarriedStackTrace());
        }
    }

    if (index >= 256) {
        this._queueGC();
    }
};

Promise.prototype._isProxied = function Promise$_isProxied() {
    return (this._bitField & 4194304) === 4194304;
};

Promise.prototype._setProxied = function Promise$_setProxied() {
    this._bitField = this._bitField | 4194304;
};

Promise.prototype._unsetProxied = function Promise$_unsetProxied() {
    this._bitField = this._bitField & (~4194304);
};

Promise.prototype._isGcQueued = function Promise$_isGcQueued() {
    return (this._bitField & -1073741824) === -1073741824;
};

Promise.prototype._setGcQueued = function Promise$_setGcQueued() {
    this._bitField = this._bitField | -1073741824;
};

Promise.prototype._unsetGcQueued = function Promise$_unsetGcQueued() {
    this._bitField = this._bitField & (~-1073741824);
};

Promise.prototype._queueGC = function Promise$_queueGC() {
    if (this._isGcQueued()) return;
    this._setGcQueued();
    async.invokeLater(this._gc, this, void 0);
};

Promise.prototype._gc = function Promise$gc() {
    var len = this._length();
    this._unsetAt(0);
    for (var i = 0; i < len; i++) {
        delete this[i];
    }
    this._setLength(0);
    this._unsetGcQueued();
};

Promise.prototype._queueSettleAt = function Promise$_queueSettleAt(index) {
    if (this._isRejectionUnhandled()) this._unsetRejectionIsUnhandled();
    async.invoke(this._settlePromiseAt, this, index);
};

Promise.prototype._fulfillUnchecked =
function Promise$_fulfillUnchecked(value) {
    if (!this.isPending()) return;
    if (value === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err, void 0);
    }
    this._cleanValues();
    this._setFulfilled();
    this._settledValue = value;
    var len = this._length();

    if (len > 0) {
        async.invoke(this._settlePromises, this, len);
    }
};

Promise.prototype._rejectUncheckedCheckError =
function Promise$_rejectUncheckedCheckError(reason) {
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._rejectUnchecked(reason, trace === reason ? void 0 : trace);
};

Promise.prototype._rejectUnchecked =
function Promise$_rejectUnchecked(reason, trace) {
    if (!this.isPending()) return;
    if (reason === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err);
    }
    this._cleanValues();
    this._setRejected();
    this._settledValue = reason;

    if (this._isFinal()) {
        async.invokeLater(thrower, void 0, trace === void 0 ? reason : trace);
        return;
    }
    var len = this._length();

    if (trace !== void 0) this._setCarriedStackTrace(trace);

    if (len > 0) {
        async.invoke(this._rejectPromises, this, null);
    }
    else {
        this._ensurePossibleRejectionHandled();
    }
};

Promise.prototype._rejectPromises = function Promise$_rejectPromises() {
    this._settlePromises();
    this._unsetCarriedStackTrace();
};

Promise.prototype._settlePromises = function Promise$_settlePromises() {
    var len = this._length();
    for (var i = 0; i < len; i+= 5) {
        this._settlePromiseAt(i);
    }
};

Promise.prototype._ensurePossibleRejectionHandled =
function Promise$_ensurePossibleRejectionHandled() {
    this._setRejectionIsUnhandled();
    if (CapturedTrace.possiblyUnhandledRejection !== void 0) {
        async.invokeLater(this._notifyUnhandledRejection, this, void 0);
    }
};

Promise.prototype._notifyUnhandledRejectionIsHandled =
function Promise$_notifyUnhandledRejectionIsHandled() {
    if (typeof unhandledRejectionHandled === "function") {
        async.invokeLater(unhandledRejectionHandled, void 0, this);
    }
};

Promise.prototype._notifyUnhandledRejection =
function Promise$_notifyUnhandledRejection() {
    if (this._isRejectionUnhandled()) {
        var reason = this._settledValue;
        var trace = this._getCarriedStackTrace();

        this._setUnhandledRejectionIsNotified();

        if (trace !== void 0) {
            this._unsetCarriedStackTrace();
            reason = trace;
        }
        if (typeof CapturedTrace.possiblyUnhandledRejection === "function") {
            CapturedTrace.possiblyUnhandledRejection(reason, this);
        }
    }
};

var contextStack = [];
Promise.prototype._peekContext = function Promise$_peekContext() {
    var lastIndex = contextStack.length - 1;
    if (lastIndex >= 0) {
        return contextStack[lastIndex];
    }
    return void 0;

};

Promise.prototype._pushContext = function Promise$_pushContext() {
    if (!debugging) return;
    contextStack.push(this);
};

Promise.prototype._popContext = function Promise$_popContext() {
    if (!debugging) return;
    contextStack.pop();
};

function Promise$_CreatePromiseArray(
    promises, PromiseArrayConstructor, boundTo) {

    var list = null;
    if (isArray(promises)) {
        list = promises;
    }
    else {
        list = Promise._cast(promises, void 0);
        if (list !== promises) {
            list._setBoundTo(boundTo);
        }
        else if (!isPromise(list)) {
            list = null;
        }
    }
    if (list !== null) {
        return new PromiseArrayConstructor(list, boundTo);
    }
    return {
        promise: function() {return apiRejection("expecting an array, a promise or a thenable");}
    };
}

var old = global.Promise;
Promise.noConflict = function() {
    if (global.Promise === Promise) {
        global.Promise = old;
    }
    return Promise;
};

if (!CapturedTrace.isSupported()) {
    Promise.longStackTraces = function(){};
    debugging = false;
}

Promise._makeSelfResolutionError = makeSelfResolutionError;
_dereq_("./finally.js")(Promise, NEXT_FILTER);
_dereq_("./direct_resolve.js")(Promise);
_dereq_("./thenables.js")(Promise, INTERNAL);
_dereq_("./synchronous_inspection.js")(Promise);
Promise.RangeError = RangeError;
Promise.CancellationError = CancellationError;
Promise.TimeoutError = TimeoutError;
Promise.TypeError = TypeError;
Promise.RejectionError = RejectionError;

util.toFastProperties(Promise);
util.toFastProperties(Promise.prototype);
_dereq_('./timers.js')(Promise,INTERNAL);
_dereq_('./any.js')(Promise,Promise$_CreatePromiseArray,PromiseArray);
_dereq_('./race.js')(Promise,INTERNAL);
_dereq_('./call_get.js')(Promise);
_dereq_('./filter.js')(Promise,Promise$_CreatePromiseArray,PromiseArray,apiRejection);
_dereq_('./generators.js')(Promise,apiRejection,INTERNAL);
_dereq_('./map.js')(Promise,PromiseArray,INTERNAL,apiRejection);
_dereq_('./nodeify.js')(Promise);
_dereq_('./promisify.js')(Promise,INTERNAL);
_dereq_('./props.js')(Promise,PromiseArray);
_dereq_('./reduce.js')(Promise,Promise$_CreatePromiseArray,PromiseArray,apiRejection,INTERNAL);
_dereq_('./settle.js')(Promise,Promise$_CreatePromiseArray,PromiseArray);
_dereq_('./some.js')(Promise,Promise$_CreatePromiseArray,PromiseArray,apiRejection);
_dereq_('./progress.js')(Promise,isPromiseArrayProxy);
_dereq_('./cancel.js')(Promise,INTERNAL);

Promise.prototype = Promise.prototype;
return Promise;

};

}).call(this,_dereq_("FWaASH"))
},{"./any.js":108,"./async.js":109,"./call_get.js":111,"./cancel.js":112,"./captured_trace.js":113,"./catch_filter.js":114,"./direct_resolve.js":115,"./errors.js":116,"./errors_api_rejection":117,"./filter.js":119,"./finally.js":120,"./generators.js":121,"./global.js":122,"./map.js":123,"./nodeify.js":124,"./progress.js":125,"./promise_array.js":127,"./promise_resolver.js":128,"./promisify.js":130,"./props.js":132,"./race.js":134,"./reduce.js":135,"./settle.js":137,"./some.js":139,"./synchronous_inspection.js":141,"./thenables.js":142,"./timers.js":143,"./util.js":144,"FWaASH":166}],127:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var canAttach = _dereq_("./errors.js").canAttach;
var util = _dereq_("./util.js");
var async = _dereq_("./async.js");
var hasOwn = {}.hasOwnProperty;
var isArray = util.isArray;

function toResolutionValue(val) {
    switch(val) {
    case -1: return void 0;
    case -2: return [];
    case -3: return {};
    }
}

function PromiseArray(values, boundTo) {
    var promise = this._promise = new Promise(INTERNAL);
    var parent = void 0;
    if (values instanceof Promise) {
        parent = values;
        if (values._cancellable()) {
            promise._setCancellable();
            promise._cancellationParent = values;
        }
        if (values._isBound()) {
            promise._setBoundTo(boundTo);
        }
    }
    promise._setTrace(parent);
    this._values = values;
    this._length = 0;
    this._totalResolved = 0;
    this._init(void 0, -2);
}
PromiseArray.PropertiesPromiseArray = function() {};

PromiseArray.prototype.length = function PromiseArray$length() {
    return this._length;
};

PromiseArray.prototype.promise = function PromiseArray$promise() {
    return this._promise;
};

PromiseArray.prototype._init =
function PromiseArray$_init(_, resolveValueIfEmpty) {
    var values = this._values;
    if (values instanceof Promise) {
        if (values.isFulfilled()) {
            values = values._settledValue;
            if (!isArray(values)) {
                var err = new Promise.TypeError("expecting an array, a promise or a thenable");
                this.__hardReject__(err);
                return;
            }
            this._values = values;
        }
        else if (values.isPending()) {
            values._then(
                this._init,
                this._reject,
                void 0,
                this,
                resolveValueIfEmpty
           );
            return;
        }
        else {
            values._unsetRejectionIsUnhandled();
            this._reject(values._settledValue);
            return;
        }
    }

    if (values.length === 0) {
        this._resolve(toResolutionValue(resolveValueIfEmpty));
        return;
    }
    var len = values.length;
    var newLen = len;
    var newValues;
    if (this instanceof PromiseArray.PropertiesPromiseArray) {
        newValues = this._values;
    }
    else {
        newValues = new Array(len);
    }
    var isDirectScanNeeded = false;
    for (var i = 0; i < len; ++i) {
        var promise = values[i];
        if (promise === void 0 && !hasOwn.call(values, i)) {
            newLen--;
            continue;
        }
        var maybePromise = Promise._cast(promise, void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                maybePromise._proxyPromiseArray(this, i);
            }
            else {
                maybePromise._unsetRejectionIsUnhandled();
                isDirectScanNeeded = true;
            }
        }
        else {
            isDirectScanNeeded = true;
        }
        newValues[i] = maybePromise;
    }
    if (newLen === 0) {
        if (resolveValueIfEmpty === -2) {
            this._resolve(newValues);
        }
        else {
            this._resolve(toResolutionValue(resolveValueIfEmpty));
        }
        return;
    }
    this._values = newValues;
    this._length = newLen;
    if (isDirectScanNeeded) {
        var scanMethod = newLen === len
            ? this._scanDirectValues
            : this._scanDirectValuesHoled;
        async.invoke(scanMethod, this, len);
    }
};

PromiseArray.prototype._settlePromiseAt =
function PromiseArray$_settlePromiseAt(index) {
    var value = this._values[index];
    if (!(value instanceof Promise)) {
        this._promiseFulfilled(value, index);
    }
    else if (value.isFulfilled()) {
        this._promiseFulfilled(value._settledValue, index);
    }
    else if (value.isRejected()) {
        this._promiseRejected(value._settledValue, index);
    }
};

PromiseArray.prototype._scanDirectValuesHoled =
function PromiseArray$_scanDirectValuesHoled(len) {
    for (var i = 0; i < len; ++i) {
        if (this._isResolved()) {
            break;
        }
        if (hasOwn.call(this._values, i)) {
            this._settlePromiseAt(i);
        }
    }
};

PromiseArray.prototype._scanDirectValues =
function PromiseArray$_scanDirectValues(len) {
    for (var i = 0; i < len; ++i) {
        if (this._isResolved()) {
            break;
        }
        this._settlePromiseAt(i);
    }
};

PromiseArray.prototype._isResolved = function PromiseArray$_isResolved() {
    return this._values === null;
};

PromiseArray.prototype._resolve = function PromiseArray$_resolve(value) {
    this._values = null;
    this._promise._fulfill(value);
};

PromiseArray.prototype.__hardReject__ =
PromiseArray.prototype._reject = function PromiseArray$_reject(reason) {
    this._values = null;
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._promise._attachExtraTrace(trace);
    this._promise._reject(reason, trace);
};

PromiseArray.prototype._promiseProgressed =
function PromiseArray$_promiseProgressed(progressValue, index) {
    if (this._isResolved()) return;
    this._promise._progress({
        index: index,
        value: progressValue
    });
};


PromiseArray.prototype._promiseFulfilled =
function PromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

PromiseArray.prototype._promiseRejected =
function PromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    this._totalResolved++;
    this._reject(reason);
};

return PromiseArray;
};

},{"./async.js":109,"./errors.js":116,"./util.js":144}],128:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = _dereq_("./util.js");
var maybeWrapAsError = util.maybeWrapAsError;
var errors = _dereq_("./errors.js");
var TimeoutError = errors.TimeoutError;
var RejectionError = errors.RejectionError;
var async = _dereq_("./async.js");
var haveGetters = util.haveGetters;
var es5 = _dereq_("./es5.js");

function isUntypedError(obj) {
    return obj instanceof Error &&
        es5.getPrototypeOf(obj) === Error.prototype;
}

function wrapAsRejectionError(obj) {
    var ret;
    if (isUntypedError(obj)) {
        ret = new RejectionError(obj);
    }
    else {
        ret = obj;
    }
    errors.markAsOriginatingFromRejection(ret);
    return ret;
}

function nodebackForPromise(promise) {
    function PromiseResolver$_callback(err, value) {
        if (promise === null) return;

        if (err) {
            var wrapped = wrapAsRejectionError(maybeWrapAsError(err));
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        }
        else {
            if (arguments.length > 2) {
                var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}
                promise._fulfill(args);
            }
            else {
                promise._fulfill(value);
            }
        }

        promise = null;
    }
    return PromiseResolver$_callback;
}


var PromiseResolver;
if (!haveGetters) {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
        this.asCallback = nodebackForPromise(promise);
        this.callback = this.asCallback;
    };
}
else {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
    };
}
if (haveGetters) {
    var prop = {
        get: function() {
            return nodebackForPromise(this.promise);
        }
    };
    es5.defineProperty(PromiseResolver.prototype, "asCallback", prop);
    es5.defineProperty(PromiseResolver.prototype, "callback", prop);
}

PromiseResolver._nodebackForPromise = nodebackForPromise;

PromiseResolver.prototype.toString = function PromiseResolver$toString() {
    return "[object PromiseResolver]";
};

PromiseResolver.prototype.resolve =
PromiseResolver.prototype.fulfill = function PromiseResolver$resolve(value) {
    var promise = this.promise;
    if ((promise === void 0) || (promise._tryFollow === void 0)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }
    if (promise._tryFollow(value)) {
        return;
    }
    async.invoke(promise._fulfill, promise, value);
};

PromiseResolver.prototype.reject = function PromiseResolver$reject(reason) {
    var promise = this.promise;
    if ((promise === void 0) || (promise._attachExtraTrace === void 0)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }
    errors.markAsOriginatingFromRejection(reason);
    var trace = errors.canAttach(reason) ? reason : new Error(reason + "");
    promise._attachExtraTrace(trace);
    async.invoke(promise._reject, promise, reason);
    if (trace !== reason) {
        async.invoke(this._setCarriedStackTrace, this, trace);
    }
};

PromiseResolver.prototype.progress =
function PromiseResolver$progress(value) {
    async.invoke(this.promise._progress, this.promise, value);
};

PromiseResolver.prototype.cancel = function PromiseResolver$cancel() {
    async.invoke(this.promise.cancel, this.promise, void 0);
};

PromiseResolver.prototype.timeout = function PromiseResolver$timeout() {
    this.reject(new TimeoutError("timeout"));
};

PromiseResolver.prototype.isResolved = function PromiseResolver$isResolved() {
    return this.promise.isResolved();
};

PromiseResolver.prototype.toJSON = function PromiseResolver$toJSON() {
    return this.promise.toJSON();
};

PromiseResolver.prototype._setCarriedStackTrace =
function PromiseResolver$_setCarriedStackTrace(trace) {
    if (this.promise.isRejected()) {
        this.promise._setCarriedStackTrace(trace);
    }
};

module.exports = PromiseResolver;

},{"./async.js":109,"./errors.js":116,"./es5.js":118,"./util.js":144}],129:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var errors = _dereq_("./errors.js");
var TypeError = errors.TypeError;
var util = _dereq_("./util.js");
var isArray = util.isArray;
var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var yieldHandlers = [];

function promiseFromYieldHandler(value) {
    var _yieldHandlers = yieldHandlers;
    var _errorObj = errorObj;
    var _Promise = Promise;
    var len = _yieldHandlers.length;
    for (var i = 0; i < len; ++i) {
        var result = tryCatch1(_yieldHandlers[i], void 0, value);
        if (result === _errorObj) {
            return _Promise.reject(_errorObj.e);
        }
        var maybePromise = _Promise._cast(result,
            promiseFromYieldHandler, void 0);
        if (maybePromise instanceof _Promise) return maybePromise;
    }
    return null;
}

function PromiseSpawn(generatorFunction, receiver) {
    var promise = this._promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    this._generatorFunction = generatorFunction;
    this._receiver = receiver;
    this._generator = void 0;
}

PromiseSpawn.prototype.promise = function PromiseSpawn$promise() {
    return this._promise;
};

PromiseSpawn.prototype._run = function PromiseSpawn$_run() {
    this._generator = this._generatorFunction.call(this._receiver);
    this._receiver =
        this._generatorFunction = void 0;
    this._next(void 0);
};

PromiseSpawn.prototype._continue = function PromiseSpawn$_continue(result) {
    if (result === errorObj) {
        this._generator = void 0;
        var trace = errors.canAttach(result.e)
            ? result.e : new Error(result.e + "");
        this._promise._attachExtraTrace(trace);
        this._promise._reject(result.e, trace);
        return;
    }

    var value = result.value;
    if (result.done === true) {
        this._generator = void 0;
        if (!this._promise._tryFollow(value)) {
            this._promise._fulfill(value);
        }
    }
    else {
        var maybePromise = Promise._cast(value, PromiseSpawn$_continue, void 0);
        if (!(maybePromise instanceof Promise)) {
            if (isArray(maybePromise)) {
                maybePromise = Promise.all(maybePromise);
            }
            else {
                maybePromise = promiseFromYieldHandler(maybePromise);
            }
            if (maybePromise === null) {
                this._throw(new TypeError("A value was yielded that could not be treated as a promise"));
                return;
            }
        }
        maybePromise._then(
            this._next,
            this._throw,
            void 0,
            this,
            null
       );
    }
};

PromiseSpawn.prototype._throw = function PromiseSpawn$_throw(reason) {
    if (errors.canAttach(reason))
        this._promise._attachExtraTrace(reason);
    this._continue(
        tryCatch1(this._generator["throw"], this._generator, reason)
   );
};

PromiseSpawn.prototype._next = function PromiseSpawn$_next(value) {
    this._continue(
        tryCatch1(this._generator.next, this._generator, value)
   );
};

PromiseSpawn.addYieldHandler = function PromiseSpawn$AddYieldHandler(fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    yieldHandlers.push(fn);
};

return PromiseSpawn;
};

},{"./errors.js":116,"./util.js":144}],130:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var THIS = {};
var util = _dereq_("./util.js");
var es5 = _dereq_("./es5.js");
var nodebackForPromise = _dereq_("./promise_resolver.js")
    ._nodebackForPromise;
var withAppended = util.withAppended;
var maybeWrapAsError = util.maybeWrapAsError;
var canEvaluate = util.canEvaluate;
var deprecated = util.deprecated;
var TypeError = _dereq_("./errors").TypeError;


var rasyncSuffix = new RegExp("Async" + "$");
function isPromisified(fn) {
    return fn.__isPromisified__ === true;
}
function hasPromisified(obj, key) {
    var containsKey = ((key + "Async") in obj);
    return containsKey ? isPromisified(obj[key + "Async"])
                       : false;
}
function checkValid(ret) {
    for (var i = 0; i < ret.length; i += 2) {
        var key = ret[i];
        if (rasyncSuffix.test(key)) {
            var keyWithoutAsyncSuffix = key.replace(rasyncSuffix, "");
            for (var j = 0; j < ret.length; j += 2) {
                if (ret[j] === keyWithoutAsyncSuffix) {
                    throw new TypeError("Cannot promisify an API " +
                        "that has normal methods with Async-suffix");
                }
            }
        }
    }
}
var inheritedMethods = (function() {
    if (es5.isES5) {
        var create = Object.create;
        var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        return function(cur) {
            var ret = [];
            var visitedKeys = create(null);
            var original = cur;
            while (cur !== null) {
                var keys = es5.keys(cur);
                for (var i = 0, len = keys.length; i < len; ++i) {
                    var key = keys[i];
                    if (visitedKeys[key]) continue;
                    visitedKeys[key] = true;
                    var desc = getOwnPropertyDescriptor(cur, key);

                    if (desc != null &&
                        typeof desc.value === "function" &&
                        !isPromisified(desc.value) &&
                        !hasPromisified(original, key)) {
                        ret.push(key, desc.value);
                    }
                }
                cur = es5.getPrototypeOf(cur);
            }
            checkValid(ret);
            return ret;
        };
    }
    else {
        return function(obj) {
            var ret = [];
            /*jshint forin:false */
            for (var key in obj) {
                var fn = obj[key];
                if (typeof fn === "function" &&
                    !isPromisified(fn) &&
                    !hasPromisified(obj, key)) {
                    ret.push(key, fn);
                }
            }
            checkValid(ret);
            return ret;
        };
    }
})();

function switchCaseArgumentOrder(likelyArgumentCount) {
    var ret = [likelyArgumentCount];
    var min = Math.max(0, likelyArgumentCount - 1 - 5);
    for(var i = likelyArgumentCount - 1; i >= min; --i) {
        if (i === likelyArgumentCount) continue;
        ret.push(i);
    }
    for(var i = likelyArgumentCount + 1; i <= 5; ++i) {
        ret.push(i);
    }
    return ret;
}

function parameterDeclaration(parameterCount) {
    var ret = new Array(parameterCount);
    for(var i = 0; i < ret.length; ++i) {
        ret[i] = "_arg" + i;
    }
    return ret.join(", ");
}

function parameterCount(fn) {
    if (typeof fn.length === "number") {
        return Math.max(Math.min(fn.length, 1023 + 1), 0);
    }
    return 0;
}

var rident = /^[a-z$_][a-z$_0-9]*$/i;
function propertyAccess(id) {
    if (rident.test(id)) {
        return "." + id;
    }
    else return "['" + id.replace(/(['\\])/g, "\\$1") + "']";
}

function makeNodePromisifiedEval(callback, receiver, originalName, fn) {
    var newParameterCount = Math.max(0, parameterCount(fn) - 1);
    var argumentOrder = switchCaseArgumentOrder(newParameterCount);

    var callbackName = (typeof originalName === "string" ?
        originalName + "Async" :
        "promisified");

    function generateCallForArgumentCount(count) {
        var args = new Array(count);
        for (var i = 0, len = args.length; i < len; ++i) {
            args[i] = "arguments[" + i + "]";
        }
        var comma = count > 0 ? "," : "";

        if (typeof callback === "string" &&
            receiver === THIS) {
            return "this" + propertyAccess(callback) + "("+args.join(",") +
                comma +" fn);"+
                "break;";
        }
        return (receiver === void 0
            ? "callback("+args.join(",")+ comma +" fn);"
            : "callback.call("+(receiver === THIS
                ? "this"
                : "receiver")+", "+args.join(",") + comma + " fn);") +
        "break;";
    }

    if (!rident.test(callbackName)) {
        callbackName = "promisified";
    }

    function generateArgumentSwitchCase() {
        var ret = "";
        for(var i = 0; i < argumentOrder.length; ++i) {
            ret += "case " + argumentOrder[i] +":" +
                generateCallForArgumentCount(argumentOrder[i]);
        }
        ret += "default: var args = new Array(len + 1);" +
            "var i = 0;" +
            "for (var i = 0; i < len; ++i) { " +
            "   args[i] = arguments[i];" +
            "}" +
            "args[i] = fn;" +

            (typeof callback === "string"
            ? "this" + propertyAccess(callback) + ".apply("
            : "callback.apply(") +

            (receiver === THIS ? "this" : "receiver") +
            ", args); break;";
        return ret;
    }

    return new Function("Promise", "callback", "receiver",
            "withAppended", "maybeWrapAsError", "nodebackForPromise",
            "INTERNAL",
        "var ret = function " + callbackName +
        "(" + parameterDeclaration(newParameterCount) + ") {\"use strict\";" +
        "var len = arguments.length;" +
        "var promise = new Promise(INTERNAL);"+
        "promise._setTrace(void 0);" +
        "var fn = nodebackForPromise(promise);"+
        "try {" +
        "switch(len) {" +
        generateArgumentSwitchCase() +
        "}" +
        "}" +
        "catch(e){ " +
        "var wrapped = maybeWrapAsError(e);" +
        "promise._attachExtraTrace(wrapped);" +
        "promise._reject(wrapped);" +
        "}" +
        "return promise;" +
        "" +
        "}; ret.__isPromisified__ = true; return ret;"
   )(Promise, callback, receiver, withAppended,
        maybeWrapAsError, nodebackForPromise, INTERNAL);
}

function makeNodePromisifiedClosure(callback, receiver) {
    function promisified() {
        var _receiver = receiver;
        if (receiver === THIS) _receiver = this;
        if (typeof callback === "string") {
            callback = _receiver[callback];
        }
        var promise = new Promise(INTERNAL);
        promise._setTrace(void 0);
        var fn = nodebackForPromise(promise);
        try {
            callback.apply(_receiver, withAppended(arguments, fn));
        }
        catch(e) {
            var wrapped = maybeWrapAsError(e);
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        }
        return promise;
    }
    promisified.__isPromisified__ = true;
    return promisified;
}

var makeNodePromisified = canEvaluate
    ? makeNodePromisifiedEval
    : makeNodePromisifiedClosure;

function _promisify(callback, receiver, isAll) {
    if (isAll) {
        var methods = inheritedMethods(callback);
        for (var i = 0, len = methods.length; i < len; i+= 2) {
            var key = methods[i];
            var fn = methods[i+1];
            var promisifiedKey = key + "Async";
            callback[promisifiedKey] = makeNodePromisified(key, THIS, key, fn);
        }
        util.toFastProperties(callback);
        return callback;
    }
    else {
        return makeNodePromisified(callback, receiver, void 0, callback);
    }
}

Promise.promisify = function Promise$Promisify(fn, receiver) {
    if (typeof fn === "object" && fn !== null) {
        deprecated("Promise.promisify for promisifying entire objects is deprecated. Use Promise.promisifyAll instead.");
        return _promisify(fn, receiver, true);
    }
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    if (isPromisified(fn)) {
        return fn;
    }
    return _promisify(
        fn,
        arguments.length < 2 ? THIS : receiver,
        false);
};

Promise.promisifyAll = function Promise$PromisifyAll(target) {
    if (typeof target !== "function" && typeof target !== "object") {
        throw new TypeError("the target of promisifyAll must be an object or a function");
    }
    return _promisify(target, void 0, true);
};
};


},{"./errors":116,"./es5.js":118,"./promise_resolver.js":128,"./util.js":144}],131:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray) {
var util = _dereq_("./util.js");
var inherits = util.inherits;
var es5 = _dereq_("./es5.js");

function PropertiesPromiseArray(obj, boundTo) {
    var keys = es5.keys(obj);
    var values = new Array(keys.length);
    for (var i = 0, len = values.length; i < len; ++i) {
        values[i] = obj[keys[i]];
    }
    this.constructor$(values, boundTo);
    if (!this._isResolved()) {
        for (var i = 0, len = keys.length; i < len; ++i) {
            values.push(keys[i]);
        }
    }
}
inherits(PropertiesPromiseArray, PromiseArray);

PropertiesPromiseArray.prototype._init =
function PropertiesPromiseArray$_init() {
    this._init$(void 0, -3) ;
};

PropertiesPromiseArray.prototype._promiseFulfilled =
function PropertiesPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        var val = {};
        var keyOffset = this.length();
        for (var i = 0, len = this.length(); i < len; ++i) {
            val[this._values[i + keyOffset]] = this._values[i];
        }
        this._resolve(val);
    }
};

PropertiesPromiseArray.prototype._promiseProgressed =
function PropertiesPromiseArray$_promiseProgressed(value, index) {
    if (this._isResolved()) return;

    this._promise._progress({
        key: this._values[index + this.length()],
        value: value
    });
};

PromiseArray.PropertiesPromiseArray = PropertiesPromiseArray;

return PropertiesPromiseArray;
};

},{"./es5.js":118,"./util.js":144}],132:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray) {
var PropertiesPromiseArray = _dereq_("./properties_promise_array.js")(
    Promise, PromiseArray);
var util = _dereq_("./util.js");
var apiRejection = _dereq_("./errors_api_rejection")(Promise);
var isObject = util.isObject;

function Promise$_Props(promises, useBound) {
    var ret;
    var castValue = Promise._cast(promises, void 0);

    if (!isObject(castValue)) {
        return apiRejection("cannot await properties of a non-object");
    }
    else if (castValue instanceof Promise) {
        ret = castValue._then(Promise.props, void 0, void 0,
                        void 0, void 0);
    }
    else {
        ret = new PropertiesPromiseArray(
            castValue,
            useBound === true && castValue._isBound()
                        ? castValue._boundTo
                        : void 0
       ).promise();
        useBound = false;
    }
    if (useBound === true && castValue._isBound()) {
        ret._setBoundTo(castValue._boundTo);
    }
    return ret;
}

Promise.prototype.props = function Promise$props() {
    return Promise$_Props(this, true);
};

Promise.props = function Promise$Props(promises) {
    return Promise$_Props(promises, false);
};
};

},{"./errors_api_rejection":117,"./properties_promise_array.js":131,"./util.js":144}],133:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
function arrayCopy(src, srcIndex, dst, dstIndex, len) {
    for (var j = 0; j < len; ++j) {
        dst[j + dstIndex] = src[j + srcIndex];
    }
}

function pow2AtLeast(n) {
    n = n >>> 0;
    n = n - 1;
    n = n | (n >> 1);
    n = n | (n >> 2);
    n = n | (n >> 4);
    n = n | (n >> 8);
    n = n | (n >> 16);
    return n + 1;
}

function getCapacity(capacity) {
    if (typeof capacity !== "number") return 16;
    return pow2AtLeast(
        Math.min(
            Math.max(16, capacity), 1073741824)
   );
}

function Queue(capacity) {
    this._capacity = getCapacity(capacity);
    this._length = 0;
    this._front = 0;
    this._makeCapacity();
}

Queue.prototype._willBeOverCapacity =
function Queue$_willBeOverCapacity(size) {
    return this._capacity < size;
};

Queue.prototype._pushOne = function Queue$_pushOne(arg) {
    var length = this.length();
    this._checkCapacity(length + 1);
    var i = (this._front + length) & (this._capacity - 1);
    this[i] = arg;
    this._length = length + 1;
};

Queue.prototype.push = function Queue$push(fn, receiver, arg) {
    var length = this.length() + 3;
    if (this._willBeOverCapacity(length)) {
        this._pushOne(fn);
        this._pushOne(receiver);
        this._pushOne(arg);
        return;
    }
    var j = this._front + length - 3;
    this._checkCapacity(length);
    var wrapMask = this._capacity - 1;
    this[(j + 0) & wrapMask] = fn;
    this[(j + 1) & wrapMask] = receiver;
    this[(j + 2) & wrapMask] = arg;
    this._length = length;
};

Queue.prototype.shift = function Queue$shift() {
    var front = this._front,
        ret = this[front];

    this[front] = void 0;
    this._front = (front + 1) & (this._capacity - 1);
    this._length--;
    return ret;
};

Queue.prototype.length = function Queue$length() {
    return this._length;
};

Queue.prototype._makeCapacity = function Queue$_makeCapacity() {
    var len = this._capacity;
    for (var i = 0; i < len; ++i) {
        this[i] = void 0;
    }
};

Queue.prototype._checkCapacity = function Queue$_checkCapacity(size) {
    if (this._capacity < size) {
        this._resizeTo(this._capacity << 3);
    }
};

Queue.prototype._resizeTo = function Queue$_resizeTo(capacity) {
    var oldFront = this._front;
    var oldCapacity = this._capacity;
    var oldQueue = new Array(oldCapacity);
    var length = this.length();

    arrayCopy(this, 0, oldQueue, 0, oldCapacity);
    this._capacity = capacity;
    this._makeCapacity();
    this._front = 0;
    if (oldFront + length <= oldCapacity) {
        arrayCopy(oldQueue, oldFront, this, 0, length);
    }
    else {        var lengthBeforeWrapping =
            length - ((oldFront + length) & (oldCapacity - 1));

        arrayCopy(oldQueue, oldFront, this, 0, lengthBeforeWrapping);
        arrayCopy(oldQueue, 0, this, lengthBeforeWrapping,
                    length - lengthBeforeWrapping);
    }
};

module.exports = Queue;

},{}],134:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var apiRejection = _dereq_("./errors_api_rejection.js")(Promise);
var isArray = _dereq_("./util.js").isArray;

var raceLater = function Promise$_raceLater(promise) {
    return promise.then(function(array) {
        return Promise$_Race(array, promise);
    });
};

var hasOwn = {}.hasOwnProperty;
function Promise$_Race(promises, parent) {
    var maybePromise = Promise._cast(promises, void 0);

    if (maybePromise instanceof Promise) {
        return raceLater(maybePromise);
    }
    else if (!isArray(promises)) {
        return apiRejection("expecting an array, a promise or a thenable");
    }

    var ret = new Promise(INTERNAL);
    ret._setTrace(parent);
    if (parent !== void 0) {
        if (parent._isBound()) {
            ret._setBoundTo(parent._boundTo);
        }
        if (parent._cancellable()) {
            ret._setCancellable();
            ret._cancellationParent = parent;
        }
    }
    var fulfill = ret._fulfill;
    var reject = ret._reject;
    for (var i = 0, len = promises.length; i < len; ++i) {
        var val = promises[i];

        if (val === void 0 && !(hasOwn.call(promises, i))) {
            continue;
        }

        Promise.cast(val)._then(
            fulfill,
            reject,
            void 0,
            ret,
            null
       );
    }
    return ret;
}

Promise.race = function Promise$Race(promises) {
    return Promise$_Race(promises, void 0);
};

Promise.prototype.race = function Promise$race() {
    return Promise$_Race(this, void 0);
};

};

},{"./errors_api_rejection.js":117,"./util.js":144}],135:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(
    Promise, Promise$_CreatePromiseArray,
    PromiseArray, apiRejection, INTERNAL) {

function Reduction(callback, index, accum, items, receiver) {
    this.promise = new Promise(INTERNAL);
    this.index = index;
    this.length = items.length;
    this.items = items;
    this.callback = callback;
    this.receiver = receiver;
    this.accum = accum;
}

Reduction.prototype.reject = function Reduction$reject(e) {
    this.promise._reject(e);
};

Reduction.prototype.fulfill = function Reduction$fulfill(value, index) {
    this.accum = value;
    this.index = index + 1;
    this.iterate();
};

Reduction.prototype.iterate = function Reduction$iterate() {
    var i = this.index;
    var len = this.length;
    var items = this.items;
    var result = this.accum;
    var receiver = this.receiver;
    var callback = this.callback;

    for (; i < len; ++i) {
        result = callback.call(receiver, result, items[i], i, len);
        result = Promise._cast(result, void 0);

        if (result instanceof Promise) {
            result._then(
                this.fulfill, this.reject, void 0, this, i);
            return;
        }
    }
    this.promise._fulfill(result);
};

function Promise$_reducer(fulfilleds, initialValue) {
    var fn = this;
    var receiver = void 0;
    if (typeof fn !== "function")  {
        receiver = fn.receiver;
        fn = fn.fn;
    }
    var len = fulfilleds.length;
    var accum = void 0;
    var startIndex = 0;

    if (initialValue !== void 0) {
        accum = initialValue;
        startIndex = 0;
    }
    else {
        startIndex = 1;
        if (len > 0) accum = fulfilleds[0];
    }
    var i = startIndex;

    if (i >= len) {
        return accum;
    }

    var reduction = new Reduction(fn, i, accum, fulfilleds, receiver);
    reduction.iterate();
    return reduction.promise;
}

function Promise$_unpackReducer(fulfilleds) {
    var fn = this.fn;
    var initialValue = this.initialValue;
    return Promise$_reducer.call(fn, fulfilleds, initialValue);
}

function Promise$_slowReduce(
    promises, fn, initialValue, useBound) {
    return initialValue._then(function(initialValue) {
        return Promise$_Reduce(
            promises, fn, initialValue, useBound);
    }, void 0, void 0, void 0, void 0);
}

function Promise$_Reduce(promises, fn, initialValue, useBound) {
    if (typeof fn !== "function") {
        return apiRejection("fn must be a function");
    }

    if (useBound === true && promises._isBound()) {
        fn = {
            fn: fn,
            receiver: promises._boundTo
        };
    }

    if (initialValue !== void 0) {
        if (initialValue instanceof Promise) {
            if (initialValue.isFulfilled()) {
                initialValue = initialValue._settledValue;
            }
            else {
                return Promise$_slowReduce(promises,
                    fn, initialValue, useBound);
            }
        }

        return Promise$_CreatePromiseArray(promises, PromiseArray,
            useBound === true && promises._isBound()
                ? promises._boundTo
                : void 0)
            .promise()
            ._then(Promise$_unpackReducer, void 0, void 0, {
                fn: fn,
                initialValue: initialValue
            }, void 0);
    }
    return Promise$_CreatePromiseArray(promises, PromiseArray,
            useBound === true && promises._isBound()
                ? promises._boundTo
                : void 0).promise()
        ._then(Promise$_reducer, void 0, void 0, fn, void 0);
}


Promise.reduce = function Promise$Reduce(promises, fn, initialValue) {
    return Promise$_Reduce(promises, fn, initialValue, false);
};

Promise.prototype.reduce = function Promise$reduce(fn, initialValue) {
    return Promise$_Reduce(this, fn, initialValue, true);
};
};

},{}],136:[function(_dereq_,module,exports){
(function (process){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var global = _dereq_("./global.js");
var schedule;
if (typeof process !== "undefined" && process !== null &&
    typeof process.cwd === "function" &&
    typeof process.nextTick === "function" &&
    typeof process.version === "string") {
    schedule = function Promise$_Scheduler(fn) {
        process.nextTick(fn);
    };
}
else if ((typeof global.MutationObserver === "function" ||
        typeof global.WebkitMutationObserver === "function" ||
        typeof global.WebKitMutationObserver === "function") &&
        typeof document !== "undefined" &&
        typeof document.createElement === "function") {


    schedule = (function(){
        var MutationObserver = global.MutationObserver ||
            global.WebkitMutationObserver ||
            global.WebKitMutationObserver;
        var div = document.createElement("div");
        var queuedFn = void 0;
        var observer = new MutationObserver(
            function Promise$_Scheduler() {
                var fn = queuedFn;
                queuedFn = void 0;
                fn();
            }
       );
        observer.observe(div, {
            attributes: true
        });
        return function Promise$_Scheduler(fn) {
            queuedFn = fn;
            div.setAttribute("class", "foo");
        };

    })();
}
else if (typeof global.postMessage === "function" &&
    typeof global.importScripts !== "function" &&
    typeof global.addEventListener === "function" &&
    typeof global.removeEventListener === "function") {

    var MESSAGE_KEY = "bluebird_message_key_" + Math.random();
    schedule = (function(){
        var queuedFn = void 0;

        function Promise$_Scheduler(e) {
            if (e.source === global &&
                e.data === MESSAGE_KEY) {
                var fn = queuedFn;
                queuedFn = void 0;
                fn();
            }
        }

        global.addEventListener("message", Promise$_Scheduler, false);

        return function Promise$_Scheduler(fn) {
            queuedFn = fn;
            global.postMessage(
                MESSAGE_KEY, "*"
           );
        };

    })();
}
else if (typeof global.MessageChannel === "function") {
    schedule = (function(){
        var queuedFn = void 0;

        var channel = new global.MessageChannel();
        channel.port1.onmessage = function Promise$_Scheduler() {
                var fn = queuedFn;
                queuedFn = void 0;
                fn();
        };

        return function Promise$_Scheduler(fn) {
            queuedFn = fn;
            channel.port2.postMessage(null);
        };
    })();
}
else if (global.setTimeout) {
    schedule = function Promise$_Scheduler(fn) {
        setTimeout(fn, 4);
    };
}
else {
    schedule = function Promise$_Scheduler(fn) {
        fn();
    };
}

module.exports = schedule;

}).call(this,_dereq_("FWaASH"))
},{"./global.js":122,"FWaASH":166}],137:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
    function(Promise, Promise$_CreatePromiseArray, PromiseArray) {

var SettledPromiseArray = _dereq_("./settled_promise_array.js")(
    Promise, PromiseArray);

function Promise$_Settle(promises, useBound) {
    return Promise$_CreatePromiseArray(
        promises,
        SettledPromiseArray,
        useBound === true && promises._isBound()
            ? promises._boundTo
            : void 0
   ).promise();
}

Promise.settle = function Promise$Settle(promises) {
    return Promise$_Settle(promises, false);
};

Promise.prototype.settle = function Promise$settle() {
    return Promise$_Settle(this, true);
};
};

},{"./settled_promise_array.js":138}],138:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray) {
var PromiseInspection = Promise.PromiseInspection;
var util = _dereq_("./util.js");
var inherits = util.inherits;
function SettledPromiseArray(values, boundTo) {
    this.constructor$(values, boundTo);
}
inherits(SettledPromiseArray, PromiseArray);

SettledPromiseArray.prototype._promiseResolved =
function SettledPromiseArray$_promiseResolved(index, inspection) {
    this._values[index] = inspection;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

SettledPromiseArray.prototype._promiseFulfilled =
function SettledPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 268435456;
    ret._settledValue = value;
    this._promiseResolved(index, ret);
};
SettledPromiseArray.prototype._promiseRejected =
function SettledPromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 134217728;
    ret._settledValue = reason;
    this._promiseResolved(index, ret);
};

return SettledPromiseArray;
};

},{"./util.js":144}],139:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
function(Promise, Promise$_CreatePromiseArray, PromiseArray, apiRejection) {

var SomePromiseArray = _dereq_("./some_promise_array.js")(PromiseArray);
function Promise$_Some(promises, howMany, useBound) {
    if ((howMany | 0) !== howMany || howMany < 0) {
        return apiRejection("expecting a positive integer");
    }
    var ret = Promise$_CreatePromiseArray(
        promises,
        SomePromiseArray,
        useBound === true && promises._isBound()
            ? promises._boundTo
            : void 0
   );
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(howMany);
    ret.init();
    return promise;
}

Promise.some = function Promise$Some(promises, howMany) {
    return Promise$_Some(promises, howMany, false);
};

Promise.prototype.some = function Promise$some(count) {
    return Promise$_Some(this, count, true);
};

};

},{"./some_promise_array.js":140}],140:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function (PromiseArray) {
var util = _dereq_("./util.js");
var RangeError = _dereq_("./errors.js").RangeError;
var inherits = util.inherits;
var isArray = util.isArray;

function SomePromiseArray(values, boundTo) {
    this.constructor$(values, boundTo);
    this._howMany = 0;
    this._unwrap = false;
    this._initialized = false;
}
inherits(SomePromiseArray, PromiseArray);

SomePromiseArray.prototype._init = function SomePromiseArray$_init() {
    if (!this._initialized) {
        return;
    }
    if (this._howMany === 0) {
        this._resolve([]);
        return;
    }
    this._init$(void 0, -2);
    var isArrayResolved = isArray(this._values);
    this._holes = isArrayResolved ? this._values.length - this.length() : 0;

    if (!this._isResolved() &&
        isArrayResolved &&
        this._howMany > this._canPossiblyFulfill()) {
        var message = "(Promise.some) input array contains less than " +
                        this._howMany  + " promises";
        this._reject(new RangeError(message));
    }
};

SomePromiseArray.prototype.init = function SomePromiseArray$init() {
    this._initialized = true;
    this._init();
};

SomePromiseArray.prototype.setUnwrap = function SomePromiseArray$setUnwrap() {
    this._unwrap = true;
};

SomePromiseArray.prototype.howMany = function SomePromiseArray$howMany() {
    return this._howMany;
};

SomePromiseArray.prototype.setHowMany =
function SomePromiseArray$setHowMany(count) {
    if (this._isResolved()) return;
    this._howMany = count;
};

SomePromiseArray.prototype._promiseFulfilled =
function SomePromiseArray$_promiseFulfilled(value) {
    if (this._isResolved()) return;
    this._addFulfilled(value);
    if (this._fulfilled() === this.howMany()) {
        this._values.length = this.howMany();
        if (this.howMany() === 1 && this._unwrap) {
            this._resolve(this._values[0]);
        }
        else {
            this._resolve(this._values);
        }
    }

};
SomePromiseArray.prototype._promiseRejected =
function SomePromiseArray$_promiseRejected(reason) {
    if (this._isResolved()) return;
    this._addRejected(reason);
    if (this.howMany() > this._canPossiblyFulfill()) {
        if (this._values.length === this.length()) {
            this._reject([]);
        }
        else {
            this._reject(this._values.slice(this.length() + this._holes));
        }
    }
};

SomePromiseArray.prototype._fulfilled = function SomePromiseArray$_fulfilled() {
    return this._totalResolved;
};

SomePromiseArray.prototype._rejected = function SomePromiseArray$_rejected() {
    return this._values.length - this.length() - this._holes;
};

SomePromiseArray.prototype._addRejected =
function SomePromiseArray$_addRejected(reason) {
    this._values.push(reason);
};

SomePromiseArray.prototype._addFulfilled =
function SomePromiseArray$_addFulfilled(value) {
    this._values[this._totalResolved++] = value;
};

SomePromiseArray.prototype._canPossiblyFulfill =
function SomePromiseArray$_canPossiblyFulfill() {
    return this.length() - this._rejected();
};

return SomePromiseArray;
};

},{"./errors.js":116,"./util.js":144}],141:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
function PromiseInspection(promise) {
    if (promise !== void 0) {
        this._bitField = promise._bitField;
        this._settledValue = promise.isResolved()
            ? promise._settledValue
            : void 0;
    }
    else {
        this._bitField = 0;
        this._settledValue = void 0;
    }
}

PromiseInspection.prototype.isFulfilled =
Promise.prototype.isFulfilled = function Promise$isFulfilled() {
    return (this._bitField & 268435456) > 0;
};

PromiseInspection.prototype.isRejected =
Promise.prototype.isRejected = function Promise$isRejected() {
    return (this._bitField & 134217728) > 0;
};

PromiseInspection.prototype.isPending =
Promise.prototype.isPending = function Promise$isPending() {
    return (this._bitField & 402653184) === 0;
};

PromiseInspection.prototype.value =
Promise.prototype.value = function Promise$value() {
    if (!this.isFulfilled()) {
        throw new TypeError("cannot get fulfillment value of a non-fulfilled promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.error =
Promise.prototype.reason = function Promise$reason() {
    if (!this.isRejected()) {
        throw new TypeError("cannot get rejection reason of a non-rejected promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.isResolved =
Promise.prototype.isResolved = function Promise$isResolved() {
    return (this._bitField & 402653184) > 0;
};

Promise.prototype.inspect = function Promise$inspect() {
    return new PromiseInspection(this);
};

Promise.PromiseInspection = PromiseInspection;
};

},{}],142:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var util = _dereq_("./util.js");
var canAttach = _dereq_("./errors.js").canAttach;
var errorObj = util.errorObj;
var isObject = util.isObject;

function getThen(obj) {
    try {
        return obj.then;
    }
    catch(e) {
        errorObj.e = e;
        return errorObj;
    }
}

function Promise$_Cast(obj, originalPromise) {
    if (isObject(obj)) {
        if (obj instanceof Promise) {
            return obj;
        }
        else if (isAnyBluebirdPromise(obj)) {
            var ret = new Promise(INTERNAL);
            ret._setTrace(void 0);
            obj._then(
                ret._fulfillUnchecked,
                ret._rejectUncheckedCheckError,
                ret._progressUnchecked,
                ret,
                null
            );
            ret._setFollowing();
            return ret;
        }
        var then = getThen(obj);
        if (then === errorObj) {
            if (originalPromise !== void 0 && canAttach(then.e)) {
                originalPromise._attachExtraTrace(then.e);
            }
            return Promise.reject(then.e);
        }
        else if (typeof then === "function") {
            return Promise$_doThenable(obj, then, originalPromise);
        }
    }
    return obj;
}

var hasProp = {}.hasOwnProperty;
function isAnyBluebirdPromise(obj) {
    return hasProp.call(obj, "_promise0");
}

function Promise$_doThenable(x, then, originalPromise) {
    var resolver = Promise.defer();
    var called = false;
    try {
        then.call(
            x,
            Promise$_resolveFromThenable,
            Promise$_rejectFromThenable,
            Promise$_progressFromThenable
        );
    }
    catch(e) {
        if (!called) {
            called = true;
            var trace = canAttach(e) ? e : new Error(e + "");
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(trace);
            }
            resolver.promise._reject(e, trace);
        }
    }
    return resolver.promise;

    function Promise$_resolveFromThenable(y) {
        if (called) return;
        called = true;

        if (x === y) {
            var e = Promise._makeSelfResolutionError();
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(e);
            }
            resolver.promise._reject(e, void 0);
            return;
        }
        resolver.resolve(y);
    }

    function Promise$_rejectFromThenable(r) {
        if (called) return;
        called = true;
        var trace = canAttach(r) ? r : new Error(r + "");
        if (originalPromise !== void 0) {
            originalPromise._attachExtraTrace(trace);
        }
        resolver.promise._reject(r, trace);
    }

    function Promise$_progressFromThenable(v) {
        if (called) return;
        var promise = resolver.promise;
        if (typeof promise._progress === "function") {
            promise._progress(v);
        }
    }
}

Promise._cast = Promise$_Cast;
};

},{"./errors.js":116,"./util.js":144}],143:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var global = _dereq_("./global.js");
var setTimeout = function(fn, ms) {
    var $_len = arguments.length;var args = new Array($_len - 2); for(var $_i = 2; $_i < $_len; ++$_i) {args[$_i - 2] = arguments[$_i];}
    global.setTimeout(function(){
        fn.apply(void 0, args);
    }, ms);
};

module.exports = function(Promise, INTERNAL) {
var util = _dereq_("./util.js");
var errors = _dereq_("./errors.js");
var apiRejection = _dereq_("./errors_api_rejection")(Promise);
var TimeoutError = Promise.TimeoutError;

var afterTimeout = function Promise$_afterTimeout(promise, message, ms) {
    if (!promise.isPending()) return;
    if (typeof message !== "string") {
        message = "operation timed out after" + " " + ms + " ms"
    }
    var err = new TimeoutError(message);
    errors.markAsOriginatingFromRejection(err);
    promise._attachExtraTrace(err);
    promise._rejectUnchecked(err);
};

var afterDelay = function Promise$_afterDelay(value, promise) {
    promise._fulfill(value);
};

var delay = Promise.delay = function Promise$Delay(value, ms) {
    if (ms === void 0) {
        ms = value;
        value = void 0;
    }
    ms = +ms;
    var maybePromise = Promise._cast(value, void 0);
    var promise = new Promise(INTERNAL);

    if (maybePromise instanceof Promise) {
        if (maybePromise._isBound()) {
            promise._setBoundTo(maybePromise._boundTo);
        }
        if (maybePromise._cancellable()) {
            promise._setCancellable();
            promise._cancellationParent = maybePromise;
        }
        promise._setTrace(maybePromise);
        promise._follow(maybePromise);
        return promise.then(function(value) {
            return Promise.delay(value, ms);
        });
    }
    else {
        promise._setTrace(void 0);
        setTimeout(afterDelay, ms, value, promise);
    }
    return promise;
};

Promise.prototype.delay = function Promise$delay(ms) {
    return delay(this, ms);
};

Promise.prototype.timeout = function Promise$timeout(ms, message) {
    ms = +ms;

    var ret = new Promise(INTERNAL);
    ret._setTrace(this);

    if (this._isBound()) ret._setBoundTo(this._boundTo);
    if (this._cancellable()) {
        ret._setCancellable();
        ret._cancellationParent = this;
    }
    ret._follow(this);
    setTimeout(afterTimeout, ms, ret, message, ms);
    return ret;
};

};

},{"./errors.js":116,"./errors_api_rejection":117,"./global.js":122,"./util.js":144}],144:[function(_dereq_,module,exports){
/**
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var global = _dereq_("./global.js");
var es5 = _dereq_("./es5.js");
var haveGetters = (function(){
    try {
        var o = {};
        es5.defineProperty(o, "f", {
            get: function () {
                return 3;
            }
        });
        return o.f === 3;
    }
    catch (e) {
        return false;
    }

})();

var canEvaluate = (function() {
    if (typeof window !== "undefined" && window !== null &&
        typeof window.document !== "undefined" &&
        typeof navigator !== "undefined" && navigator !== null &&
        typeof navigator.appName === "string" &&
        window === global) {
        return false;
    }
    return true;
})();

function deprecated(msg) {
    if (typeof console !== "undefined" && console !== null &&
        typeof console.warn === "function") {
        console.warn("Bluebird: " + msg);
    }
}

var errorObj = {e: {}};
function tryCatch1(fn, receiver, arg) {
    try {
        return fn.call(receiver, arg);
    }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch2(fn, receiver, arg, arg2) {
    try {
        return fn.call(receiver, arg, arg2);
    }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatchApply(fn, args, receiver) {
    try {
        return fn.apply(receiver, args);
    }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

var inherits = function(Child, Parent) {
    var hasProp = {}.hasOwnProperty;

    function T() {
        this.constructor = Child;
        this.constructor$ = Parent;
        for (var propertyName in Parent.prototype) {
            if (hasProp.call(Parent.prototype, propertyName) &&
                propertyName.charAt(propertyName.length-1) !== "$"
           ) {
                this[propertyName + "$"] = Parent.prototype[propertyName];
            }
        }
    }
    T.prototype = Parent.prototype;
    Child.prototype = new T();
    return Child.prototype;
};

function asString(val) {
    return typeof val === "string" ? val : ("" + val);
}

function isPrimitive(val) {
    return val == null || val === true || val === false ||
        typeof val === "string" || typeof val === "number";

}

function isObject(value) {
    return !isPrimitive(value);
}

function maybeWrapAsError(maybeError) {
    if (!isPrimitive(maybeError)) return maybeError;

    return new Error(asString(maybeError));
}

function withAppended(target, appendee) {
    var len = target.length;
    var ret = new Array(len + 1);
    var i;
    for (i = 0; i < len; ++i) {
        ret[i] = target[i];
    }
    ret[i] = appendee;
    return ret;
}


function notEnumerableProp(obj, name, value) {
    if (isPrimitive(obj)) return obj;
    var descriptor = {
        value: value,
        configurable: true,
        enumerable: false,
        writable: true
    };
    es5.defineProperty(obj, name, descriptor);
    return obj;
}


var wrapsPrimitiveReceiver = (function() {
    return this !== "string";
}).call("string");

function thrower(r) {
    throw r;
}


function toFastProperties(obj) {
    /*jshint -W027*/
    function f() {}
    f.prototype = obj;
    return f;
    eval(obj);
}

var ret = {
    thrower: thrower,
    isArray: es5.isArray,
    haveGetters: haveGetters,
    notEnumerableProp: notEnumerableProp,
    isPrimitive: isPrimitive,
    isObject: isObject,
    canEvaluate: canEvaluate,
    deprecated: deprecated,
    errorObj: errorObj,
    tryCatch1: tryCatch1,
    tryCatch2: tryCatch2,
    tryCatchApply: tryCatchApply,
    inherits: inherits,
    withAppended: withAppended,
    asString: asString,
    maybeWrapAsError: maybeWrapAsError,
    wrapsPrimitiveReceiver: wrapsPrimitiveReceiver,
    toFastProperties: toFastProperties
};

module.exports = ret;

},{"./es5.js":118,"./global.js":122}],145:[function(_dereq_,module,exports){
// Browser Request
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var XHR = XMLHttpRequest
if (!XHR) throw new Error('missing XMLHttpRequest')

module.exports = request
request.log = {
  'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop
}

var DEFAULT_TIMEOUT = 3 * 60 * 1000 // 3 minutes

//
// request
//

function request(options, callback) {
  // The entry-point to the API: prep the options object and pass the real work to run_xhr.
  if(typeof callback !== 'function')
    throw new Error('Bad callback given: ' + callback)

  if(!options)
    throw new Error('No options given')

  var options_onResponse = options.onResponse; // Save this for later.

  if(typeof options === 'string')
    options = {'uri':options};
  else
    options = JSON.parse(JSON.stringify(options)); // Use a duplicate for mutating.

  options.onResponse = options_onResponse // And put it back.

  if (options.verbose) request.log = getLogger();

  if(options.url) {
    options.uri = options.url;
    delete options.url;
  }

  if(!options.uri && options.uri !== "")
    throw new Error("options.uri is a required argument");

  if(typeof options.uri != "string")
    throw new Error("options.uri must be a string");

  var unsupported_options = ['proxy', '_redirectsFollowed', 'maxRedirects', 'followRedirect']
  for (var i = 0; i < unsupported_options.length; i++)
    if(options[ unsupported_options[i] ])
      throw new Error("options." + unsupported_options[i] + " is not supported")

  options.callback = callback
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body    = options.body || null
  options.timeout = options.timeout || request.DEFAULT_TIMEOUT

  if(options.headers.host)
    throw new Error("Options.headers.host is not supported");

  if(options.json) {
    options.headers.accept = options.headers.accept || 'application/json'
    if(options.method !== 'GET')
      options.headers['content-type'] = 'application/json'

    if(typeof options.json !== 'boolean')
      options.body = JSON.stringify(options.json)
    else if(typeof options.body !== 'string')
      options.body = JSON.stringify(options.body)
  }

  // If onResponse is boolean true, call back immediately when the response is known,
  // not when the full request is complete.
  options.onResponse = options.onResponse || noop
  if(options.onResponse === true) {
    options.onResponse = callback
    options.callback = noop
  }

  // XXX Browsers do not like this.
  //if(options.body)
  //  options.headers['content-length'] = options.body.length;

  // HTTP basic authentication
  if(!options.headers.authorization && options.auth)
    options.headers.authorization = 'Basic ' + b64_enc(options.auth.username + ':' + options.auth.password);

  return run_xhr(options)
}

var req_seq = 0
function run_xhr(options) {
  var xhr = new XHR
    , timed_out = false
    , is_cors = is_crossDomain(options.uri)
    , supports_cors = ('withCredentials' in xhr)

  req_seq += 1
  xhr.seq_id = req_seq
  xhr.id = req_seq + ': ' + options.method + ' ' + options.uri
  xhr._id = xhr.id // I know I will type "_id" from habit all the time.

  if(is_cors && !supports_cors) {
    var cors_err = new Error('Browser does not support cross-origin request: ' + options.uri)
    cors_err.cors = 'unsupported'
    return options.callback(cors_err, xhr)
  }

  xhr.timeoutTimer = setTimeout(too_late, options.timeout)
  function too_late() {
    timed_out = true
    var er = new Error('ETIMEDOUT')
    er.code = 'ETIMEDOUT'
    er.duration = options.timeout

    request.log.error('Timeout', { 'id':xhr._id, 'milliseconds':options.timeout })
    return options.callback(er, xhr)
  }

  // Some states can be skipped over, so remember what is still incomplete.
  var did = {'response':false, 'loading':false, 'end':false}

  xhr.onreadystatechange = on_state_change
  xhr.open(options.method, options.uri, true) // asynchronous
  if(is_cors)
    xhr.withCredentials = !! options.withCredentials
  xhr.send(options.body)
  return xhr

  function on_state_change(event) {
    if(timed_out)
      return request.log.debug('Ignoring timed out state change', {'state':xhr.readyState, 'id':xhr.id})

    request.log.debug('State change', {'state':xhr.readyState, 'id':xhr.id, 'timed_out':timed_out})

    if(xhr.readyState === XHR.OPENED) {
      request.log.debug('Request started', {'id':xhr.id})
      for (var key in options.headers)
        xhr.setRequestHeader(key, options.headers[key])
    }

    else if(xhr.readyState === XHR.HEADERS_RECEIVED)
      on_response()

    else if(xhr.readyState === XHR.LOADING) {
      on_response()
      on_loading()
    }

    else if(xhr.readyState === XHR.DONE) {
      on_response()
      on_loading()
      on_end()
    }
  }

  function on_response() {
    if(did.response)
      return

    did.response = true
    request.log.debug('Got response', {'id':xhr.id, 'status':xhr.status})
    clearTimeout(xhr.timeoutTimer)
    xhr.statusCode = xhr.status // Node request compatibility

    // Detect failed CORS requests.
    if(is_cors && xhr.statusCode == 0) {
      var cors_err = new Error('CORS request rejected: ' + options.uri)
      cors_err.cors = 'rejected'

      // Do not process this request further.
      did.loading = true
      did.end = true

      return options.callback(cors_err, xhr)
    }

    options.onResponse(null, xhr)
  }

  function on_loading() {
    if(did.loading)
      return

    did.loading = true
    request.log.debug('Response body loading', {'id':xhr.id})
    // TODO: Maybe simulate "data" events by watching xhr.responseText
  }

  function on_end() {
    if(did.end)
      return

    did.end = true
    request.log.debug('Request done', {'id':xhr.id})

    xhr.body = xhr.responseText
    if(options.json) {
      try        { xhr.body = JSON.parse(xhr.responseText) }
      catch (er) { return options.callback(er, xhr)        }
    }

    options.callback(null, xhr, xhr.body)
  }

} // request

request.withCredentials = false;
request.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

//
// defaults
//

request.defaults = function(options, requester) {
  var def = function (method) {
    var d = function (params, callback) {
      if(typeof params === 'string')
        params = {'uri': params};
      else {
        params = JSON.parse(JSON.stringify(params));
      }
      for (var i in options) {
        if (params[i] === undefined) params[i] = options[i]
      }
      return method(params, callback)
    }
    return d
  }
  var de = def(request)
  de.get = def(request.get)
  de.post = def(request.post)
  de.put = def(request.put)
  de.head = def(request.head)
  return de
}

//
// HTTP method shortcuts
//

var shortcuts = [ 'get', 'put', 'post', 'head' ];
shortcuts.forEach(function(shortcut) {
  var method = shortcut.toUpperCase();
  var func   = shortcut.toLowerCase();

  request[func] = function(opts) {
    if(typeof opts === 'string')
      opts = {'method':method, 'uri':opts};
    else {
      opts = JSON.parse(JSON.stringify(opts));
      opts.method = method;
    }

    var args = [opts].concat(Array.prototype.slice.apply(arguments, [1]));
    return request.apply(this, args);
  }
})

//
// CouchDB shortcut
//

request.couch = function(options, callback) {
  if(typeof options === 'string')
    options = {'uri':options}

  // Just use the request API to do JSON.
  options.json = true
  if(options.body)
    options.json = options.body
  delete options.body

  callback = callback || noop

  var xhr = request(options, couch_handler)
  return xhr

  function couch_handler(er, resp, body) {
    if(er)
      return callback(er, resp, body)

    if((resp.statusCode < 200 || resp.statusCode > 299) && body.error) {
      // The body is a Couch JSON object indicating the error.
      er = new Error('CouchDB error: ' + (body.error.reason || body.error.error))
      for (var key in body)
        er[key] = body[key]
      return callback(er, resp, body);
    }

    return callback(er, resp, body);
  }
}

//
// Utility
//

function noop() {}

function getLogger() {
  var logger = {}
    , levels = ['trace', 'debug', 'info', 'warn', 'error']
    , level, i

  for(i = 0; i < levels.length; i++) {
    level = levels[i]

    logger[level] = noop
    if(typeof console !== 'undefined' && console && console[level])
      logger[level] = formatted(console, level)
  }

  return logger
}

function formatted(obj, method) {
  return formatted_logger

  function formatted_logger(str, context) {
    if(typeof context === 'object')
      str += ' ' + JSON.stringify(context)

    return obj[method].call(obj, str)
  }
}

// Return whether a URL is a cross-domain request.
function is_crossDomain(url) {
  var rurl = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/

  // jQuery #8138, IE may throw an exception when accessing
  // a field from window.location if document.domain has been set
  var ajaxLocation
  try { ajaxLocation = location.href }
  catch (e) {
    // Use the href attribute of an A element since IE will modify it given document.location
    ajaxLocation = document.createElement( "a" );
    ajaxLocation.href = "";
    ajaxLocation = ajaxLocation.href;
  }

  var ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || []
    , parts = rurl.exec(url.toLowerCase() )

  var result = !!(
    parts &&
    (  parts[1] != ajaxLocParts[1]
    || parts[2] != ajaxLocParts[2]
    || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? 80 : 443))
    )
  )

  //console.debug('is_crossDomain('+url+') -> ' + result)
  return result
}

// MIT License from http://phpjs.org/functions/base64_encode:358
function b64_enc (data) {
    // Encodes string using MIME base64 algorithm
    var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, enc="", tmp_arr = [];

    if (!data) {
        return data;
    }

    // assume utf8 data
    // data = this.utf8_encode(data+'');

    do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1<<16 | o2<<8 | o3;

        h1 = bits>>18 & 0x3f;
        h2 = bits>>12 & 0x3f;
        h3 = bits>>6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
    } while (i < data.length);

    enc = tmp_arr.join('');

    switch (data.length % 3) {
        case 1:
            enc = enc.slice(0, -2) + '==';
        break;
        case 2:
            enc = enc.slice(0, -1) + '=';
        break;
    }

    return enc;
}

},{}],146:[function(_dereq_,module,exports){

},{}],147:[function(_dereq_,module,exports){
module.exports=_dereq_(146)
},{}],148:[function(_dereq_,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = _dereq_('base64-js')
var ieee754 = _dereq_('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = Buffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192

/**
 * If `Buffer._useTypedArrays`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (compatible down to IE6)
 */
Buffer._useTypedArrays = (function () {
  // Detect if browser supports Typed Arrays. Supported browsers are IE 10+, Firefox 4+,
  // Chrome 7+, Safari 5.1+, Opera 11.6+, iOS 4.2+. If the browser does not support adding
  // properties to `Uint8Array` instances, then that's the same as no `Uint8Array` support
  // because we need to be able to add all the node Buffer API methods. This is an issue
  // in Firefox 4-29. Now fixed: https://bugzilla.mozilla.org/show_bug.cgi?id=695438
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return 42 === arr.foo() &&
        typeof arr.subarray === 'function' // Chrome 9-10 lack `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding, noZero) {
  if (!(this instanceof Buffer))
    return new Buffer(subject, encoding, noZero)

  var type = typeof subject

  if (encoding === 'base64' && type === 'string') {
    subject = base64clean(subject)
  }

  // Find the length
  var length
  if (type === 'number')
    length = coerce(subject)
  else if (type === 'string')
    length = Buffer.byteLength(subject, encoding)
  else if (type === 'object')
    length = coerce(subject.length) // assume that object is array-like
  else
    throw new Error('First argument needs to be a number, array or string.')

  var buf
  if (Buffer._useTypedArrays) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    buf = Buffer._augment(new Uint8Array(length))
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    buf = this
    buf.length = length
    buf._isBuffer = true
  }

  var i
  if (Buffer._useTypedArrays && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    buf._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    if (Buffer.isBuffer(subject)) {
      for (i = 0; i < length; i++)
        buf[i] = subject.readUInt8(i)
    } else {
      for (i = 0; i < length; i++)
        buf[i] = ((subject[i] % 256) + 256) % 256
    }
  } else if (type === 'string') {
    buf.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer._useTypedArrays && !noZero) {
    for (i = 0; i < length; i++) {
      buf[i] = 0
    }
  }

  return buf
}

// STATIC METHODS
// ==============

Buffer.isEncoding = function (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.isBuffer = function (b) {
  return !!(b !== null && b !== undefined && b._isBuffer)
}

Buffer.byteLength = function (str, encoding) {
  var ret
  str = str.toString()
  switch (encoding || 'utf8') {
    case 'hex':
      ret = str.length / 2
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.concat = function (list, totalLength) {
  assert(isArray(list), 'Usage: Buffer.concat(list[, length])')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (totalLength === undefined) {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

Buffer.compare = function (a, b) {
  assert(Buffer.isBuffer(a) && Buffer.isBuffer(b), 'Arguments must be Buffers')
  var x = a.length
  var y = b.length
  for (var i = 0, len = Math.min(x, y); i < len && a[i] === b[i]; i++) {}
  if (i !== len) {
    x = a[i]
    y = b[i]
  }
  if (x < y) {
    return -1
  }
  if (y < x) {
    return 1
  }
  return 0
}

// BUFFER INSTANCE METHODS
// =======================

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  assert(strLen % 2 === 0, 'Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var byte = parseInt(string.substr(i * 2, 2), 16)
    assert(!isNaN(byte), 'Invalid hex string')
    buf[offset + i] = byte
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf8ToBytes(string), buf, offset, length)
  return charsWritten
}

function asciiWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  var charsWritten = blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function utf16leWrite (buf, string, offset, length) {
  var charsWritten = blitBuffer(utf16leToBytes(string), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0
  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leWrite(this, string, offset, length)
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.prototype.toString = function (encoding, start, end) {
  var self = this

  encoding = String(encoding || 'utf8').toLowerCase()
  start = Number(start) || 0
  end = (end === undefined) ? self.length : Number(end)

  // Fastpath empty strings
  if (end === start)
    return ''

  var ret
  switch (encoding) {
    case 'hex':
      ret = hexSlice(self, start, end)
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8Slice(self, start, end)
      break
    case 'ascii':
      ret = asciiSlice(self, start, end)
      break
    case 'binary':
      ret = binarySlice(self, start, end)
      break
    case 'base64':
      ret = base64Slice(self, start, end)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = utf16leSlice(self, start, end)
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.prototype.toJSON = function () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

Buffer.prototype.equals = function (b) {
  assert(Buffer.isBuffer(b), 'Argument must be a Buffer')
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.compare = function (b) {
  assert(Buffer.isBuffer(b), 'Argument must be a Buffer')
  return Buffer.compare(this, b)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function (target, target_start, start, end) {
  var source = this

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (!target_start) target_start = 0

  // Copy 0 bytes; we're done
  if (end === start) return
  if (target.length === 0 || source.length === 0) return

  // Fatal error conditions
  assert(end >= start, 'sourceEnd < sourceStart')
  assert(target_start >= 0 && target_start < target.length,
      'targetStart out of bounds')
  assert(start >= 0 && start < source.length, 'sourceStart out of bounds')
  assert(end >= 0 && end <= source.length, 'sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length)
    end = this.length
  if (target.length - target_start < end - start)
    end = target.length - target_start + start

  var len = end - start

  if (len < 100 || !Buffer._useTypedArrays) {
    for (var i = 0; i < len; i++) {
      target[i + target_start] = this[i + start]
    }
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function binarySlice (buf, start, end) {
  return asciiSlice(buf, start, end)
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function (start, end) {
  var len = this.length
  start = clamp(start, len, 0)
  end = clamp(end, len, len)

  if (Buffer._useTypedArrays) {
    return Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    var newBuf = new Buffer(sliceLen, undefined, true)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
    return newBuf
  }
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

Buffer.prototype.readUInt8 = function (offset, noAssert) {
  if (!noAssert) {
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'Trying to read beyond buffer length')
  }

  if (offset >= this.length)
    return

  return this[offset]
}

function readUInt16 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val
  if (littleEndian) {
    val = buf[offset]
    if (offset + 1 < len)
      val |= buf[offset + 1] << 8
  } else {
    val = buf[offset] << 8
    if (offset + 1 < len)
      val |= buf[offset + 1]
  }
  return val
}

Buffer.prototype.readUInt16LE = function (offset, noAssert) {
  return readUInt16(this, offset, true, noAssert)
}

Buffer.prototype.readUInt16BE = function (offset, noAssert) {
  return readUInt16(this, offset, false, noAssert)
}

function readUInt32 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val
  if (littleEndian) {
    if (offset + 2 < len)
      val = buf[offset + 2] << 16
    if (offset + 1 < len)
      val |= buf[offset + 1] << 8
    val |= buf[offset]
    if (offset + 3 < len)
      val = val + (buf[offset + 3] << 24 >>> 0)
  } else {
    if (offset + 1 < len)
      val = buf[offset + 1] << 16
    if (offset + 2 < len)
      val |= buf[offset + 2] << 8
    if (offset + 3 < len)
      val |= buf[offset + 3]
    val = val + (buf[offset] << 24 >>> 0)
  }
  return val
}

Buffer.prototype.readUInt32LE = function (offset, noAssert) {
  return readUInt32(this, offset, true, noAssert)
}

Buffer.prototype.readUInt32BE = function (offset, noAssert) {
  return readUInt32(this, offset, false, noAssert)
}

Buffer.prototype.readInt8 = function (offset, noAssert) {
  if (!noAssert) {
    assert(offset !== undefined && offset !== null,
        'missing offset')
    assert(offset < this.length, 'Trying to read beyond buffer length')
  }

  if (offset >= this.length)
    return

  var neg = this[offset] & 0x80
  if (neg)
    return (0xff - this[offset] + 1) * -1
  else
    return this[offset]
}

function readInt16 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val = readUInt16(buf, offset, littleEndian, true)
  var neg = val & 0x8000
  if (neg)
    return (0xffff - val + 1) * -1
  else
    return val
}

Buffer.prototype.readInt16LE = function (offset, noAssert) {
  return readInt16(this, offset, true, noAssert)
}

Buffer.prototype.readInt16BE = function (offset, noAssert) {
  return readInt16(this, offset, false, noAssert)
}

function readInt32 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val = readUInt32(buf, offset, littleEndian, true)
  var neg = val & 0x80000000
  if (neg)
    return (0xffffffff - val + 1) * -1
  else
    return val
}

Buffer.prototype.readInt32LE = function (offset, noAssert) {
  return readInt32(this, offset, true, noAssert)
}

Buffer.prototype.readInt32BE = function (offset, noAssert) {
  return readInt32(this, offset, false, noAssert)
}

function readFloat (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  return ieee754.read(buf, offset, littleEndian, 23, 4)
}

Buffer.prototype.readFloatLE = function (offset, noAssert) {
  return readFloat(this, offset, true, noAssert)
}

Buffer.prototype.readFloatBE = function (offset, noAssert) {
  return readFloat(this, offset, false, noAssert)
}

function readDouble (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset + 7 < buf.length, 'Trying to read beyond buffer length')
  }

  return ieee754.read(buf, offset, littleEndian, 52, 8)
}

Buffer.prototype.readDoubleLE = function (offset, noAssert) {
  return readDouble(this, offset, true, noAssert)
}

Buffer.prototype.readDoubleBE = function (offset, noAssert) {
  return readDouble(this, offset, false, noAssert)
}

Buffer.prototype.writeUInt8 = function (value, offset, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'trying to write beyond buffer length')
    verifuint(value, 0xff)
  }

  if (offset >= this.length) return

  this[offset] = value
  return offset + 1
}

function writeUInt16 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'trying to write beyond buffer length')
    verifuint(value, 0xffff)
  }

  var len = buf.length
  if (offset >= len)
    return

  for (var i = 0, j = Math.min(len - offset, 2); i < j; i++) {
    buf[offset + i] =
        (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
            (littleEndian ? i : 1 - i) * 8
  }
  return offset + 2
}

Buffer.prototype.writeUInt16LE = function (value, offset, noAssert) {
  return writeUInt16(this, value, offset, true, noAssert)
}

Buffer.prototype.writeUInt16BE = function (value, offset, noAssert) {
  return writeUInt16(this, value, offset, false, noAssert)
}

function writeUInt32 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'trying to write beyond buffer length')
    verifuint(value, 0xffffffff)
  }

  var len = buf.length
  if (offset >= len)
    return

  for (var i = 0, j = Math.min(len - offset, 4); i < j; i++) {
    buf[offset + i] =
        (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
  return offset + 4
}

Buffer.prototype.writeUInt32LE = function (value, offset, noAssert) {
  return writeUInt32(this, value, offset, true, noAssert)
}

Buffer.prototype.writeUInt32BE = function (value, offset, noAssert) {
  return writeUInt32(this, value, offset, false, noAssert)
}

Buffer.prototype.writeInt8 = function (value, offset, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7f, -0x80)
  }

  if (offset >= this.length)
    return

  if (value >= 0)
    this.writeUInt8(value, offset, noAssert)
  else
    this.writeUInt8(0xff + value + 1, offset, noAssert)
  return offset + 1
}

function writeInt16 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7fff, -0x8000)
  }

  var len = buf.length
  if (offset >= len)
    return

  if (value >= 0)
    writeUInt16(buf, value, offset, littleEndian, noAssert)
  else
    writeUInt16(buf, 0xffff + value + 1, offset, littleEndian, noAssert)
  return offset + 2
}

Buffer.prototype.writeInt16LE = function (value, offset, noAssert) {
  return writeInt16(this, value, offset, true, noAssert)
}

Buffer.prototype.writeInt16BE = function (value, offset, noAssert) {
  return writeInt16(this, value, offset, false, noAssert)
}

function writeInt32 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7fffffff, -0x80000000)
  }

  var len = buf.length
  if (offset >= len)
    return

  if (value >= 0)
    writeUInt32(buf, value, offset, littleEndian, noAssert)
  else
    writeUInt32(buf, 0xffffffff + value + 1, offset, littleEndian, noAssert)
  return offset + 4
}

Buffer.prototype.writeInt32LE = function (value, offset, noAssert) {
  return writeInt32(this, value, offset, true, noAssert)
}

Buffer.prototype.writeInt32BE = function (value, offset, noAssert) {
  return writeInt32(this, value, offset, false, noAssert)
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to write beyond buffer length')
    verifIEEE754(value, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }

  var len = buf.length
  if (offset >= len)
    return

  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 7 < buf.length,
        'Trying to write beyond buffer length')
    verifIEEE754(value, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }

  var len = buf.length
  if (offset >= len)
    return

  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  assert(end >= start, 'end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  assert(start >= 0 && start < this.length, 'start out of bounds')
  assert(end >= 0 && end <= this.length, 'end out of bounds')

  var i
  if (typeof value === 'number') {
    for (i = start; i < end; i++) {
      this[i] = value
    }
  } else {
    var bytes = utf8ToBytes(value.toString())
    var len = bytes.length
    for (i = start; i < end; i++) {
      this[i] = bytes[i % len]
    }
  }

  return this
}

Buffer.prototype.inspect = function () {
  var out = []
  var len = this.length
  for (var i = 0; i < len; i++) {
    out[i] = toHex(this[i])
    if (i === exports.INSPECT_MAX_BYTES) {
      out[i + 1] = '...'
      break
    }
  }
  return '<Buffer ' + out.join(' ') + '>'
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer._useTypedArrays) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1) {
        buf[i] = this[i]
      }
      return buf.buffer
    }
  } else {
    throw new Error('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function (arr) {
  arr._isBuffer = true

  // save reference to original Uint8Array get/set methods before overwriting
  arr._get = arr.get
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.equals = BP.equals
  arr.compare = BP.compare
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

var INVALID_BASE64_RE = /[^+\/0-9A-z]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

// slice(start, end)
function clamp (index, len, defaultValue) {
  if (typeof index !== 'number') return defaultValue
  index = ~~index;  // Coerce to integer.
  if (index >= len) return len
  if (index >= 0) return index
  index += len
  if (index >= 0) return index
  return 0
}

function coerce (length) {
  // Coerce length to a number (possibly NaN), round up
  // in case it's fractional (e.g. 123.456) then do a
  // double negate to coerce a NaN to 0. Easy, right?
  length = ~~Math.ceil(+length)
  return length < 0 ? 0 : length
}

function isArray (subject) {
  return (Array.isArray || function (subject) {
    return Object.prototype.toString.call(subject) === '[object Array]'
  })(subject)
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    var b = str.charCodeAt(i)
    if (b <= 0x7F) {
      byteArray.push(b)
    } else {
      var start = i
      if (b >= 0xD800 && b <= 0xDFFF) i++
      var h = encodeURIComponent(str.slice(start, i+1)).substr(1).split('%')
      for (var j = 0; j < h.length; j++) {
        byteArray.push(parseInt(h[j], 16))
      }
    }
  }
  return byteArray
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(str)
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length))
      break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

/*
 * We have to make sure that the value is a valid integer. This means that it
 * is non-negative. It has no fractional component and that it does not
 * exceed the maximum allowed value.
 */
function verifuint (value, max) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value >= 0, 'specified a negative value for writing an unsigned value')
  assert(value <= max, 'value is larger than maximum value for type')
  assert(Math.floor(value) === value, 'value has a fractional component')
}

function verifsint (value, max, min) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value <= max, 'value larger than maximum allowed value')
  assert(value >= min, 'value smaller than minimum allowed value')
  assert(Math.floor(value) === value, 'value has a fractional component')
}

function verifIEEE754 (value, max, min) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value <= max, 'value larger than maximum allowed value')
  assert(value >= min, 'value smaller than minimum allowed value')
}

function assert (test, message) {
  if (!test) throw new Error(message || 'Failed assertion')
}

},{"base64-js":149,"ieee754":150}],149:[function(_dereq_,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS)
			return 62 // '+'
		if (code === SLASH)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],150:[function(_dereq_,module,exports){
exports.read = function(buffer, offset, isLE, mLen, nBytes) {
  var e, m,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      nBits = -7,
      i = isLE ? (nBytes - 1) : 0,
      d = isLE ? -1 : 1,
      s = buffer[offset + i];

  i += d;

  e = s & ((1 << (-nBits)) - 1);
  s >>= (-nBits);
  nBits += eLen;
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

  m = e & ((1 << (-nBits)) - 1);
  e >>= (-nBits);
  nBits += mLen;
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity);
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c,
      eLen = nBytes * 8 - mLen - 1,
      eMax = (1 << eLen) - 1,
      eBias = eMax >> 1,
      rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
      i = isLE ? 0 : (nBytes - 1),
      d = isLE ? 1 : -1,
      s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }
    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }
    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

  e = (e << mLen) | m;
  eLen += mLen;
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

  buffer[offset + i - d] |= s * 128;
};

},{}],151:[function(_dereq_,module,exports){
(function (Buffer){
var createHash = _dereq_('sha.js')

var md5 = toConstructor(_dereq_('./md5'))
var rmd160 = toConstructor(_dereq_('ripemd160'))

function toConstructor (fn) {
  return function () {
    var buffers = []
    var m= {
      update: function (data, enc) {
        if(!Buffer.isBuffer(data)) data = new Buffer(data, enc)
        buffers.push(data)
        return this
      },
      digest: function (enc) {
        var buf = Buffer.concat(buffers)
        var r = fn(buf)
        buffers = null
        return enc ? r.toString(enc) : r
      }
    }
    return m
  }
}

module.exports = function (alg) {
  if('md5' === alg) return new md5()
  if('rmd160' === alg) return new rmd160()
  return createHash(alg)
}

}).call(this,_dereq_("buffer").Buffer)
},{"./md5":155,"buffer":148,"ripemd160":156,"sha.js":158}],152:[function(_dereq_,module,exports){
(function (Buffer){
var createHash = _dereq_('./create-hash')

var blocksize = 64
var zeroBuffer = new Buffer(blocksize); zeroBuffer.fill(0)

module.exports = Hmac

function Hmac (alg, key) {
  if(!(this instanceof Hmac)) return new Hmac(alg, key)
  this._opad = opad
  this._alg = alg

  key = this._key = !Buffer.isBuffer(key) ? new Buffer(key) : key

  if(key.length > blocksize) {
    key = createHash(alg).update(key).digest()
  } else if(key.length < blocksize) {
    key = Buffer.concat([key, zeroBuffer], blocksize)
  }

  var ipad = this._ipad = new Buffer(blocksize)
  var opad = this._opad = new Buffer(blocksize)

  for(var i = 0; i < blocksize; i++) {
    ipad[i] = key[i] ^ 0x36
    opad[i] = key[i] ^ 0x5C
  }

  this._hash = createHash(alg).update(ipad)
}

Hmac.prototype.update = function (data, enc) {
  this._hash.update(data, enc)
  return this
}

Hmac.prototype.digest = function (enc) {
  var h = this._hash.digest()
  return createHash(this._alg).update(this._opad).update(h).digest(enc)
}


}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":151,"buffer":148}],153:[function(_dereq_,module,exports){
(function (Buffer){
var intSize = 4;
var zeroBuffer = new Buffer(intSize); zeroBuffer.fill(0);
var chrsz = 8;

function toArray(buf, bigEndian) {
  if ((buf.length % intSize) !== 0) {
    var len = buf.length + (intSize - (buf.length % intSize));
    buf = Buffer.concat([buf, zeroBuffer], len);
  }

  var arr = [];
  var fn = bigEndian ? buf.readInt32BE : buf.readInt32LE;
  for (var i = 0; i < buf.length; i += intSize) {
    arr.push(fn.call(buf, i));
  }
  return arr;
}

function toBuffer(arr, size, bigEndian) {
  var buf = new Buffer(size);
  var fn = bigEndian ? buf.writeInt32BE : buf.writeInt32LE;
  for (var i = 0; i < arr.length; i++) {
    fn.call(buf, arr[i], i * 4, true);
  }
  return buf;
}

function hash(buf, fn, hashSize, bigEndian) {
  if (!Buffer.isBuffer(buf)) buf = new Buffer(buf);
  var arr = fn(toArray(buf, bigEndian), buf.length * chrsz);
  return toBuffer(arr, hashSize, bigEndian);
}

module.exports = { hash: hash };

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],154:[function(_dereq_,module,exports){
(function (Buffer){
var rng = _dereq_('./rng')

function error () {
  var m = [].slice.call(arguments).join(' ')
  throw new Error([
    m,
    'we accept pull requests',
    'http://github.com/dominictarr/crypto-browserify'
    ].join('\n'))
}

exports.createHash = _dereq_('./create-hash')

exports.createHmac = _dereq_('./create-hmac')

exports.randomBytes = function(size, callback) {
  if (callback && callback.call) {
    try {
      callback.call(this, undefined, new Buffer(rng(size)))
    } catch (err) { callback(err) }
  } else {
    return new Buffer(rng(size))
  }
}

function each(a, f) {
  for(var i in a)
    f(a[i], i)
}

exports.getHashes = function () {
  return ['sha1', 'sha256', 'md5', 'rmd160']

}

var p = _dereq_('./pbkdf2')(exports.createHmac)
exports.pbkdf2 = p.pbkdf2
exports.pbkdf2Sync = p.pbkdf2Sync


// the least I can do is make error messages for the rest of the node.js/crypto api.
each(['createCredentials'
, 'createCipher'
, 'createCipheriv'
, 'createDecipher'
, 'createDecipheriv'
, 'createSign'
, 'createVerify'
, 'createDiffieHellman'
], function (name) {
  exports[name] = function () {
    error('sorry,', name, 'is not implemented yet')
  }
})

}).call(this,_dereq_("buffer").Buffer)
},{"./create-hash":151,"./create-hmac":152,"./pbkdf2":162,"./rng":163,"buffer":148}],155:[function(_dereq_,module,exports){
/*
 * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
 * Digest Algorithm, as defined in RFC 1321.
 * Version 2.1 Copyright (C) Paul Johnston 1999 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for more info.
 */

var helpers = _dereq_('./helpers');

/*
 * Calculate the MD5 of an array of little-endian words, and a bit length
 */
function core_md5(x, len)
{
  /* append padding */
  x[len >> 5] |= 0x80 << ((len) % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;

  var a =  1732584193;
  var b = -271733879;
  var c = -1732584194;
  var d =  271733878;

  for(var i = 0; i < x.length; i += 16)
  {
    var olda = a;
    var oldb = b;
    var oldc = c;
    var oldd = d;

    a = md5_ff(a, b, c, d, x[i+ 0], 7 , -680876936);
    d = md5_ff(d, a, b, c, x[i+ 1], 12, -389564586);
    c = md5_ff(c, d, a, b, x[i+ 2], 17,  606105819);
    b = md5_ff(b, c, d, a, x[i+ 3], 22, -1044525330);
    a = md5_ff(a, b, c, d, x[i+ 4], 7 , -176418897);
    d = md5_ff(d, a, b, c, x[i+ 5], 12,  1200080426);
    c = md5_ff(c, d, a, b, x[i+ 6], 17, -1473231341);
    b = md5_ff(b, c, d, a, x[i+ 7], 22, -45705983);
    a = md5_ff(a, b, c, d, x[i+ 8], 7 ,  1770035416);
    d = md5_ff(d, a, b, c, x[i+ 9], 12, -1958414417);
    c = md5_ff(c, d, a, b, x[i+10], 17, -42063);
    b = md5_ff(b, c, d, a, x[i+11], 22, -1990404162);
    a = md5_ff(a, b, c, d, x[i+12], 7 ,  1804603682);
    d = md5_ff(d, a, b, c, x[i+13], 12, -40341101);
    c = md5_ff(c, d, a, b, x[i+14], 17, -1502002290);
    b = md5_ff(b, c, d, a, x[i+15], 22,  1236535329);

    a = md5_gg(a, b, c, d, x[i+ 1], 5 , -165796510);
    d = md5_gg(d, a, b, c, x[i+ 6], 9 , -1069501632);
    c = md5_gg(c, d, a, b, x[i+11], 14,  643717713);
    b = md5_gg(b, c, d, a, x[i+ 0], 20, -373897302);
    a = md5_gg(a, b, c, d, x[i+ 5], 5 , -701558691);
    d = md5_gg(d, a, b, c, x[i+10], 9 ,  38016083);
    c = md5_gg(c, d, a, b, x[i+15], 14, -660478335);
    b = md5_gg(b, c, d, a, x[i+ 4], 20, -405537848);
    a = md5_gg(a, b, c, d, x[i+ 9], 5 ,  568446438);
    d = md5_gg(d, a, b, c, x[i+14], 9 , -1019803690);
    c = md5_gg(c, d, a, b, x[i+ 3], 14, -187363961);
    b = md5_gg(b, c, d, a, x[i+ 8], 20,  1163531501);
    a = md5_gg(a, b, c, d, x[i+13], 5 , -1444681467);
    d = md5_gg(d, a, b, c, x[i+ 2], 9 , -51403784);
    c = md5_gg(c, d, a, b, x[i+ 7], 14,  1735328473);
    b = md5_gg(b, c, d, a, x[i+12], 20, -1926607734);

    a = md5_hh(a, b, c, d, x[i+ 5], 4 , -378558);
    d = md5_hh(d, a, b, c, x[i+ 8], 11, -2022574463);
    c = md5_hh(c, d, a, b, x[i+11], 16,  1839030562);
    b = md5_hh(b, c, d, a, x[i+14], 23, -35309556);
    a = md5_hh(a, b, c, d, x[i+ 1], 4 , -1530992060);
    d = md5_hh(d, a, b, c, x[i+ 4], 11,  1272893353);
    c = md5_hh(c, d, a, b, x[i+ 7], 16, -155497632);
    b = md5_hh(b, c, d, a, x[i+10], 23, -1094730640);
    a = md5_hh(a, b, c, d, x[i+13], 4 ,  681279174);
    d = md5_hh(d, a, b, c, x[i+ 0], 11, -358537222);
    c = md5_hh(c, d, a, b, x[i+ 3], 16, -722521979);
    b = md5_hh(b, c, d, a, x[i+ 6], 23,  76029189);
    a = md5_hh(a, b, c, d, x[i+ 9], 4 , -640364487);
    d = md5_hh(d, a, b, c, x[i+12], 11, -421815835);
    c = md5_hh(c, d, a, b, x[i+15], 16,  530742520);
    b = md5_hh(b, c, d, a, x[i+ 2], 23, -995338651);

    a = md5_ii(a, b, c, d, x[i+ 0], 6 , -198630844);
    d = md5_ii(d, a, b, c, x[i+ 7], 10,  1126891415);
    c = md5_ii(c, d, a, b, x[i+14], 15, -1416354905);
    b = md5_ii(b, c, d, a, x[i+ 5], 21, -57434055);
    a = md5_ii(a, b, c, d, x[i+12], 6 ,  1700485571);
    d = md5_ii(d, a, b, c, x[i+ 3], 10, -1894986606);
    c = md5_ii(c, d, a, b, x[i+10], 15, -1051523);
    b = md5_ii(b, c, d, a, x[i+ 1], 21, -2054922799);
    a = md5_ii(a, b, c, d, x[i+ 8], 6 ,  1873313359);
    d = md5_ii(d, a, b, c, x[i+15], 10, -30611744);
    c = md5_ii(c, d, a, b, x[i+ 6], 15, -1560198380);
    b = md5_ii(b, c, d, a, x[i+13], 21,  1309151649);
    a = md5_ii(a, b, c, d, x[i+ 4], 6 , -145523070);
    d = md5_ii(d, a, b, c, x[i+11], 10, -1120210379);
    c = md5_ii(c, d, a, b, x[i+ 2], 15,  718787259);
    b = md5_ii(b, c, d, a, x[i+ 9], 21, -343485551);

    a = safe_add(a, olda);
    b = safe_add(b, oldb);
    c = safe_add(c, oldc);
    d = safe_add(d, oldd);
  }
  return Array(a, b, c, d);

}

/*
 * These functions implement the four basic operations the algorithm uses.
 */
function md5_cmn(q, a, b, x, s, t)
{
  return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s),b);
}
function md5_ff(a, b, c, d, x, s, t)
{
  return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
}
function md5_gg(a, b, c, d, x, s, t)
{
  return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
}
function md5_hh(a, b, c, d, x, s, t)
{
  return md5_cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5_ii(a, b, c, d, x, s, t)
{
  return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
}

/*
 * Add integers, wrapping at 2^32. This uses 16-bit operations internally
 * to work around bugs in some JS interpreters.
 */
function safe_add(x, y)
{
  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xFFFF);
}

/*
 * Bitwise rotate a 32-bit number to the left.
 */
function bit_rol(num, cnt)
{
  return (num << cnt) | (num >>> (32 - cnt));
}

module.exports = function md5(buf) {
  return helpers.hash(buf, core_md5, 16);
};

},{"./helpers":153}],156:[function(_dereq_,module,exports){
(function (Buffer){

module.exports = ripemd160



/*
CryptoJS v3.1.2
code.google.com/p/crypto-js
(c) 2009-2013 by Jeff Mott. All rights reserved.
code.google.com/p/crypto-js/wiki/License
*/
/** @preserve
(c) 2012 by Cédric Mesnil. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

    - Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
    - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

// Constants table
var zl = [
    0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
    7,  4, 13,  1, 10,  6, 15,  3, 12,  0,  9,  5,  2, 14, 11,  8,
    3, 10, 14,  4,  9, 15,  8,  1,  2,  7,  0,  6, 13, 11,  5, 12,
    1,  9, 11, 10,  0,  8, 12,  4, 13,  3,  7, 15, 14,  5,  6,  2,
    4,  0,  5,  9,  7, 12,  2, 10, 14,  1,  3,  8, 11,  6, 15, 13];
var zr = [
    5, 14,  7,  0,  9,  2, 11,  4, 13,  6, 15,  8,  1, 10,  3, 12,
    6, 11,  3,  7,  0, 13,  5, 10, 14, 15,  8, 12,  4,  9,  1,  2,
    15,  5,  1,  3,  7, 14,  6,  9, 11,  8, 12,  2, 10,  0,  4, 13,
    8,  6,  4,  1,  3, 11, 15,  0,  5, 12,  2, 13,  9,  7, 10, 14,
    12, 15, 10,  4,  1,  5,  8,  7,  6,  2, 13, 14,  0,  3,  9, 11];
var sl = [
     11, 14, 15, 12,  5,  8,  7,  9, 11, 13, 14, 15,  6,  7,  9,  8,
    7, 6,   8, 13, 11,  9,  7, 15,  7, 12, 15,  9, 11,  7, 13, 12,
    11, 13,  6,  7, 14,  9, 13, 15, 14,  8, 13,  6,  5, 12,  7,  5,
      11, 12, 14, 15, 14, 15,  9,  8,  9, 14,  5,  6,  8,  6,  5, 12,
    9, 15,  5, 11,  6,  8, 13, 12,  5, 12, 13, 14, 11,  8,  5,  6 ];
var sr = [
    8,  9,  9, 11, 13, 15, 15,  5,  7,  7,  8, 11, 14, 14, 12,  6,
    9, 13, 15,  7, 12,  8,  9, 11,  7,  7, 12,  7,  6, 15, 13, 11,
    9,  7, 15, 11,  8,  6,  6, 14, 12, 13,  5, 14, 13, 13,  7,  5,
    15,  5,  8, 11, 14, 14,  6, 14,  6,  9, 12,  9, 12,  5, 15,  8,
    8,  5, 12,  9, 12,  5, 14,  6,  8, 13,  6,  5, 15, 13, 11, 11 ];

var hl =  [ 0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
var hr =  [ 0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];

var bytesToWords = function (bytes) {
  var words = [];
  for (var i = 0, b = 0; i < bytes.length; i++, b += 8) {
    words[b >>> 5] |= bytes[i] << (24 - b % 32);
  }
  return words;
};

var wordsToBytes = function (words) {
  var bytes = [];
  for (var b = 0; b < words.length * 32; b += 8) {
    bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
  }
  return bytes;
};

var processBlock = function (H, M, offset) {

  // Swap endian
  for (var i = 0; i < 16; i++) {
    var offset_i = offset + i;
    var M_offset_i = M[offset_i];

    // Swap
    M[offset_i] = (
        (((M_offset_i << 8)  | (M_offset_i >>> 24)) & 0x00ff00ff) |
        (((M_offset_i << 24) | (M_offset_i >>> 8))  & 0xff00ff00)
    );
  }

  // Working variables
  var al, bl, cl, dl, el;
  var ar, br, cr, dr, er;

  ar = al = H[0];
  br = bl = H[1];
  cr = cl = H[2];
  dr = dl = H[3];
  er = el = H[4];
  // Computation
  var t;
  for (var i = 0; i < 80; i += 1) {
    t = (al +  M[offset+zl[i]])|0;
    if (i<16){
        t +=  f1(bl,cl,dl) + hl[0];
    } else if (i<32) {
        t +=  f2(bl,cl,dl) + hl[1];
    } else if (i<48) {
        t +=  f3(bl,cl,dl) + hl[2];
    } else if (i<64) {
        t +=  f4(bl,cl,dl) + hl[3];
    } else {// if (i<80) {
        t +=  f5(bl,cl,dl) + hl[4];
    }
    t = t|0;
    t =  rotl(t,sl[i]);
    t = (t+el)|0;
    al = el;
    el = dl;
    dl = rotl(cl, 10);
    cl = bl;
    bl = t;

    t = (ar + M[offset+zr[i]])|0;
    if (i<16){
        t +=  f5(br,cr,dr) + hr[0];
    } else if (i<32) {
        t +=  f4(br,cr,dr) + hr[1];
    } else if (i<48) {
        t +=  f3(br,cr,dr) + hr[2];
    } else if (i<64) {
        t +=  f2(br,cr,dr) + hr[3];
    } else {// if (i<80) {
        t +=  f1(br,cr,dr) + hr[4];
    }
    t = t|0;
    t =  rotl(t,sr[i]) ;
    t = (t+er)|0;
    ar = er;
    er = dr;
    dr = rotl(cr, 10);
    cr = br;
    br = t;
  }
  // Intermediate hash value
  t    = (H[1] + cl + dr)|0;
  H[1] = (H[2] + dl + er)|0;
  H[2] = (H[3] + el + ar)|0;
  H[3] = (H[4] + al + br)|0;
  H[4] = (H[0] + bl + cr)|0;
  H[0] =  t;
};

function f1(x, y, z) {
  return ((x) ^ (y) ^ (z));
}

function f2(x, y, z) {
  return (((x)&(y)) | ((~x)&(z)));
}

function f3(x, y, z) {
  return (((x) | (~(y))) ^ (z));
}

function f4(x, y, z) {
  return (((x) & (z)) | ((y)&(~(z))));
}

function f5(x, y, z) {
  return ((x) ^ ((y) |(~(z))));
}

function rotl(x,n) {
  return (x<<n) | (x>>>(32-n));
}

function ripemd160(message) {
  var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];

  if (typeof message == 'string')
    message = new Buffer(message, 'utf8');

  var m = bytesToWords(message);

  var nBitsLeft = message.length * 8;
  var nBitsTotal = message.length * 8;

  // Add padding
  m[nBitsLeft >>> 5] |= 0x80 << (24 - nBitsLeft % 32);
  m[(((nBitsLeft + 64) >>> 9) << 4) + 14] = (
      (((nBitsTotal << 8)  | (nBitsTotal >>> 24)) & 0x00ff00ff) |
      (((nBitsTotal << 24) | (nBitsTotal >>> 8))  & 0xff00ff00)
  );

  for (var i=0 ; i<m.length; i += 16) {
    processBlock(H, m, i);
  }

  // Swap endian
  for (var i = 0; i < 5; i++) {
      // Shortcut
    var H_i = H[i];

    // Swap
    H[i] = (((H_i << 8)  | (H_i >>> 24)) & 0x00ff00ff) |
          (((H_i << 24) | (H_i >>> 8))  & 0xff00ff00);
  }

  var digestbytes = wordsToBytes(H);
  return new Buffer(digestbytes);
}



}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],157:[function(_dereq_,module,exports){
var u = _dereq_('./util')
var write = u.write
var fill = u.zeroFill

module.exports = function (Buffer) {

  //prototype class for hash functions
  function Hash (blockSize, finalSize) {
    this._block = new Buffer(blockSize) //new Uint32Array(blockSize/4)
    this._finalSize = finalSize
    this._blockSize = blockSize
    this._len = 0
    this._s = 0
  }

  Hash.prototype.init = function () {
    this._s = 0
    this._len = 0
  }

  function lengthOf(data, enc) {
    if(enc == null)     return data.byteLength || data.length
    if(enc == 'ascii' || enc == 'binary')  return data.length
    if(enc == 'hex')    return data.length/2
    if(enc == 'base64') return data.length/3
  }

  Hash.prototype.update = function (data, enc) {
    var bl = this._blockSize

    //I'd rather do this with a streaming encoder, like the opposite of
    //http://nodejs.org/api/string_decoder.html
    var length
      if(!enc && 'string' === typeof data)
        enc = 'utf8'

    if(enc) {
      if(enc === 'utf-8')
        enc = 'utf8'

      if(enc === 'base64' || enc === 'utf8')
        data = new Buffer(data, enc), enc = null

      length = lengthOf(data, enc)
    } else
      length = data.byteLength || data.length

    var l = this._len += length
    var s = this._s = (this._s || 0)
    var f = 0
    var buffer = this._block
    while(s < l) {
      var t = Math.min(length, f + bl)
      write(buffer, data, enc, s%bl, f, t)
      var ch = (t - f);
      s += ch; f += ch

      if(!(s%bl))
        this._update(buffer)
    }
    this._s = s

    return this

  }

  Hash.prototype.digest = function (enc) {
    var bl = this._blockSize
    var fl = this._finalSize
    var len = this._len*8

    var x = this._block

    var bits = len % (bl*8)

    //add end marker, so that appending 0's creats a different hash.
    x[this._len % bl] = 0x80
    fill(this._block, this._len % bl + 1)

    if(bits >= fl*8) {
      this._update(this._block)
      u.zeroFill(this._block, 0)
    }

    //TODO: handle case where the bit length is > Math.pow(2, 29)
    x.writeInt32BE(len, fl + 4) //big endian

    var hash = this._update(this._block) || this._hash()
    if(enc == null) return hash
    return hash.toString(enc)
  }

  Hash.prototype._update = function () {
    throw new Error('_update must be implemented by subclass')
  }

  return Hash
}

},{"./util":161}],158:[function(_dereq_,module,exports){
var exports = module.exports = function (alg) {
  var Alg = exports[alg]
  if(!Alg) throw new Error(alg + ' is not supported (we accept pull requests)')
  return new Alg()
}

var Buffer = _dereq_('buffer').Buffer
var Hash   = _dereq_('./hash')(Buffer)

exports.sha =
exports.sha1 = _dereq_('./sha1')(Buffer, Hash)
exports.sha256 = _dereq_('./sha256')(Buffer, Hash)

},{"./hash":157,"./sha1":159,"./sha256":160,"buffer":148}],159:[function(_dereq_,module,exports){
/*
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-1, as defined
 * in FIPS PUB 180-1
 * Version 2.1a Copyright Paul Johnston 2000 - 2002.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 * Distributed under the BSD License
 * See http://pajhome.org.uk/crypt/md5 for details.
 */
module.exports = function (Buffer, Hash) {

  var inherits = _dereq_('util').inherits

  inherits(Sha1, Hash)

  var A = 0|0
  var B = 4|0
  var C = 8|0
  var D = 12|0
  var E = 16|0

  var BE = false
  var LE = true

  var W = new Int32Array(80)

  var POOL = []

  function Sha1 () {
    if(POOL.length)
      return POOL.pop().init()

    if(!(this instanceof Sha1)) return new Sha1()
    this._w = W
    Hash.call(this, 16*4, 14*4)
  
    this._h = null
    this.init()
  }

  Sha1.prototype.init = function () {
    this._a = 0x67452301
    this._b = 0xefcdab89
    this._c = 0x98badcfe
    this._d = 0x10325476
    this._e = 0xc3d2e1f0

    Hash.prototype.init.call(this)
    return this
  }

  Sha1.prototype._POOL = POOL

  // assume that array is a Uint32Array with length=16,
  // and that if it is the last block, it already has the length and the 1 bit appended.


  var isDV = new Buffer(1) instanceof DataView
  function readInt32BE (X, i) {
    return isDV
      ? X.getInt32(i, false)
      : X.readInt32BE(i)
  }

  Sha1.prototype._update = function (array) {

    var X = this._block
    var h = this._h
    var a, b, c, d, e, _a, _b, _c, _d, _e

    a = _a = this._a
    b = _b = this._b
    c = _c = this._c
    d = _d = this._d
    e = _e = this._e

    var w = this._w

    for(var j = 0; j < 80; j++) {
      var W = w[j]
        = j < 16
        //? X.getInt32(j*4, false)
        //? readInt32BE(X, j*4) //*/ X.readInt32BE(j*4) //*/
        ? X.readInt32BE(j*4)
        : rol(w[j - 3] ^ w[j -  8] ^ w[j - 14] ^ w[j - 16], 1)

      var t =
        add(
          add(rol(a, 5), sha1_ft(j, b, c, d)),
          add(add(e, W), sha1_kt(j))
        );

      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }

    this._a = add(a, _a)
    this._b = add(b, _b)
    this._c = add(c, _c)
    this._d = add(d, _d)
    this._e = add(e, _e)
  }

  Sha1.prototype._hash = function () {
    if(POOL.length < 100) POOL.push(this)
    var H = new Buffer(20)
    //console.log(this._a|0, this._b|0, this._c|0, this._d|0, this._e|0)
    H.writeInt32BE(this._a|0, A)
    H.writeInt32BE(this._b|0, B)
    H.writeInt32BE(this._c|0, C)
    H.writeInt32BE(this._d|0, D)
    H.writeInt32BE(this._e|0, E)
    return H
  }

  /*
   * Perform the appropriate triplet combination function for the current
   * iteration
   */
  function sha1_ft(t, b, c, d) {
    if(t < 20) return (b & c) | ((~b) & d);
    if(t < 40) return b ^ c ^ d;
    if(t < 60) return (b & c) | (b & d) | (c & d);
    return b ^ c ^ d;
  }

  /*
   * Determine the appropriate additive constant for the current iteration
   */
  function sha1_kt(t) {
    return (t < 20) ?  1518500249 : (t < 40) ?  1859775393 :
           (t < 60) ? -1894007588 : -899497514;
  }

  /*
   * Add integers, wrapping at 2^32. This uses 16-bit operations internally
   * to work around bugs in some JS interpreters.
   * //dominictarr: this is 10 years old, so maybe this can be dropped?)
   *
   */
  function add(x, y) {
    return (x + y ) | 0
  //lets see how this goes on testling.
  //  var lsw = (x & 0xFFFF) + (y & 0xFFFF);
  //  var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  //  return (msw << 16) | (lsw & 0xFFFF);
  }

  /*
   * Bitwise rotate a 32-bit number to the left.
   */
  function rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  return Sha1
}

},{"util":169}],160:[function(_dereq_,module,exports){

/**
 * A JavaScript implementation of the Secure Hash Algorithm, SHA-256, as defined
 * in FIPS 180-2
 * Version 2.2-beta Copyright Angel Marin, Paul Johnston 2000 - 2009.
 * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
 *
 */

var inherits = _dereq_('util').inherits
var BE       = false
var LE       = true
var u        = _dereq_('./util')

module.exports = function (Buffer, Hash) {

  var K = [
      0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
      0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
      0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
      0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
      0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
      0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
      0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
      0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
      0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
      0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
      0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
      0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
      0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
      0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
      0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
      0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
    ]

  inherits(Sha256, Hash)
  var W = new Array(64)
  var POOL = []
  function Sha256() {
    if(POOL.length) {
      //return POOL.shift().init()
    }
    //this._data = new Buffer(32)

    this.init()

    this._w = W //new Array(64)

    Hash.call(this, 16*4, 14*4)
  };

  Sha256.prototype.init = function () {

    this._a = 0x6a09e667|0
    this._b = 0xbb67ae85|0
    this._c = 0x3c6ef372|0
    this._d = 0xa54ff53a|0
    this._e = 0x510e527f|0
    this._f = 0x9b05688c|0
    this._g = 0x1f83d9ab|0
    this._h = 0x5be0cd19|0

    this._len = this._s = 0

    return this
  }

  var safe_add = function(x, y) {
    var lsw = (x & 0xFFFF) + (y & 0xFFFF);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }

  function S (X, n) {
    return (X >>> n) | (X << (32 - n));
  }

  function R (X, n) {
    return (X >>> n);
  }

  function Ch (x, y, z) {
    return ((x & y) ^ ((~x) & z));
  }

  function Maj (x, y, z) {
    return ((x & y) ^ (x & z) ^ (y & z));
  }

  function Sigma0256 (x) {
    return (S(x, 2) ^ S(x, 13) ^ S(x, 22));
  }

  function Sigma1256 (x) {
    return (S(x, 6) ^ S(x, 11) ^ S(x, 25));
  }

  function Gamma0256 (x) {
    return (S(x, 7) ^ S(x, 18) ^ R(x, 3));
  }

  function Gamma1256 (x) {
    return (S(x, 17) ^ S(x, 19) ^ R(x, 10));
  }

  Sha256.prototype._update = function(m) {
    var M = this._block
    var W = this._w
    var a, b, c, d, e, f, g, h
    var T1, T2

    a = this._a | 0
    b = this._b | 0
    c = this._c | 0
    d = this._d | 0
    e = this._e | 0
    f = this._f | 0
    g = this._g | 0
    h = this._h | 0

    for (var j = 0; j < 64; j++) {
      var w = W[j] = j < 16
        ? M.readInt32BE(j * 4)
        : Gamma1256(W[j - 2]) + W[j - 7] + Gamma0256(W[j - 15]) + W[j - 16]

      T1 = h + Sigma1256(e) + Ch(e, f, g) + K[j] + w

      T2 = Sigma0256(a) + Maj(a, b, c);
      h = g; g = f; f = e; e = d + T1; d = c; c = b; b = a; a = T1 + T2;
    }

    this._a = (a + this._a) | 0
    this._b = (b + this._b) | 0
    this._c = (c + this._c) | 0
    this._d = (d + this._d) | 0
    this._e = (e + this._e) | 0
    this._f = (f + this._f) | 0
    this._g = (g + this._g) | 0
    this._h = (h + this._h) | 0

  };

  Sha256.prototype._hash = function () {
    if(POOL.length < 10)
      POOL.push(this)

    var H = new Buffer(32)

    H.writeInt32BE(this._a,  0)
    H.writeInt32BE(this._b,  4)
    H.writeInt32BE(this._c,  8)
    H.writeInt32BE(this._d, 12)
    H.writeInt32BE(this._e, 16)
    H.writeInt32BE(this._f, 20)
    H.writeInt32BE(this._g, 24)
    H.writeInt32BE(this._h, 28)

    return H
  }

  return Sha256

}

},{"./util":161,"util":169}],161:[function(_dereq_,module,exports){
exports.write = write
exports.zeroFill = zeroFill

exports.toString = toString

function write (buffer, string, enc, start, from, to, LE) {
  var l = (to - from)
  if(enc === 'ascii' || enc === 'binary') {
    for( var i = 0; i < l; i++) {
      buffer[start + i] = string.charCodeAt(i + from)
    }
  }
  else if(enc == null) {
    for( var i = 0; i < l; i++) {
      buffer[start + i] = string[i + from]
    }
  }
  else if(enc === 'hex') {
    for(var i = 0; i < l; i++) {
      var j = from + i
      buffer[start + i] = parseInt(string[j*2] + string[(j*2)+1], 16)
    }
  }
  else if(enc === 'base64') {
    throw new Error('base64 encoding not yet supported')
  }
  else
    throw new Error(enc +' encoding not yet supported')
}

//always fill to the end!
function zeroFill(buf, from) {
  for(var i = from; i < buf.length; i++)
    buf[i] = 0
}


},{}],162:[function(_dereq_,module,exports){
(function (Buffer){
// JavaScript PBKDF2 Implementation
// Based on http://git.io/qsv2zw
// Licensed under LGPL v3
// Copyright (c) 2013 jduncanator

var blocksize = 64
var zeroBuffer = new Buffer(blocksize); zeroBuffer.fill(0)

module.exports = function (createHmac, exports) {
  exports = exports || {}

  exports.pbkdf2 = function(password, salt, iterations, keylen, cb) {
    if('function' !== typeof cb)
      throw new Error('No callback provided to pbkdf2');
    setTimeout(function () {
      cb(null, exports.pbkdf2Sync(password, salt, iterations, keylen))
    })
  }

  exports.pbkdf2Sync = function(key, salt, iterations, keylen) {
    if('number' !== typeof iterations)
      throw new TypeError('Iterations not a number')
    if(iterations < 0)
      throw new TypeError('Bad iterations')
    if('number' !== typeof keylen)
      throw new TypeError('Key length not a number')
    if(keylen < 0)
      throw new TypeError('Bad key length')

    //stretch key to the correct length that hmac wants it,
    //otherwise this will happen every time hmac is called
    //twice per iteration.
    var key = !Buffer.isBuffer(key) ? new Buffer(key) : key

    if(key.length > blocksize) {
      key = createHash(alg).update(key).digest()
    } else if(key.length < blocksize) {
      key = Buffer.concat([key, zeroBuffer], blocksize)
    }

    var HMAC;
    var cplen, p = 0, i = 1, itmp = new Buffer(4), digtmp;
    var out = new Buffer(keylen);
    out.fill(0);
    while(keylen) {
      if(keylen > 20)
        cplen = 20;
      else
        cplen = keylen;

      /* We are unlikely to ever use more than 256 blocks (5120 bits!)
         * but just in case...
         */
        itmp[0] = (i >> 24) & 0xff;
        itmp[1] = (i >> 16) & 0xff;
          itmp[2] = (i >> 8) & 0xff;
          itmp[3] = i & 0xff;

          HMAC = createHmac('sha1', key);
          HMAC.update(salt)
          HMAC.update(itmp);
        digtmp = HMAC.digest();
        digtmp.copy(out, p, 0, cplen);

        for(var j = 1; j < iterations; j++) {
          HMAC = createHmac('sha1', key);
          HMAC.update(digtmp);
          digtmp = HMAC.digest();
          for(var k = 0; k < cplen; k++) {
            out[k] ^= digtmp[k];
          }
        }
      keylen -= cplen;
      i++;
      p += cplen;
    }

    return out;
  }

  return exports
}

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],163:[function(_dereq_,module,exports){
(function (Buffer){
// Original code adapted from Robert Kieffer.
// details at https://github.com/broofa/node-uuid


(function() {
  var _global = this;

  var mathRNG, whatwgRNG;

  // NOTE: Math.random() does not guarantee "cryptographic quality"
  mathRNG = function(size) {
    var bytes = new Buffer(size);
    var r;

    for (var i = 0, r; i < size; i++) {
      if ((i & 0x03) == 0) r = Math.random() * 0x100000000;
      bytes[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return bytes;
  }

  if (_global.crypto && crypto.getRandomValues) {
    whatwgRNG = function(size) {
      var bytes = new Buffer(size); //in browserify, this is an extended Uint8Array
      crypto.getRandomValues(bytes);
      return bytes;
    }
  }

  module.exports = whatwgRNG || mathRNG;

}())

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],164:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],165:[function(_dereq_,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],166:[function(_dereq_,module,exports){
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

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],167:[function(_dereq_,module,exports){
(function (global){
/*! http://mths.be/punycode v1.2.4 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports;
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^ -~]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /\x2E|\u3002|\uFF0E|\uFF61/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		while (length--) {
			array[length] = fn(array[length]);
		}
		return array;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings.
	 * @private
	 * @param {String} domain The domain name.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		return map(string.split(regexSeparators), fn).join('.');
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <http://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * http://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols to a Punycode string of ASCII-only
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name to Unicode. Only the
	 * Punycoded parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it on a string that has already been converted to
	 * Unicode.
	 * @memberOf punycode
	 * @param {String} domain The Punycode domain name to convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(domain) {
		return mapDomain(domain, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name to Punycode. Only the
	 * non-ASCII parts of the domain name will be converted, i.e. it doesn't
	 * matter if you call it with a domain that's already in ASCII.
	 * @memberOf punycode
	 * @param {String} domain The domain name to convert, as a Unicode string.
	 * @returns {String} The Punycode representation of the given domain name.
	 */
	function toASCII(domain) {
		return mapDomain(domain, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.2.4',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <http://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else { // in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],168:[function(_dereq_,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],169:[function(_dereq_,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = _dereq_('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = _dereq_('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,_dereq_("FWaASH"),typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":168,"FWaASH":166,"inherits":164}],170:[function(_dereq_,module,exports){
(function (Buffer){
(function () {
  "use strict";

  function btoa(str) {
    var buffer
      ;

    if (str instanceof Buffer) {
      buffer = str;
    } else {
      buffer = new Buffer(str.toString(), 'binary');
    }

    return buffer.toString('base64');
  }

  module.exports = btoa;
}());

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],171:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var Promise = _dereq_('bluebird');
var request = Promise.promisify(_dereq_('request'));

var jxt = _dereq_('jxt');
var XRD = _dereq_('./lib/xrd');


module.exports = function (opts, cb) {
    if (typeof opts === 'string') {
        opts = {host: opts};
    }
    opts = _.extend({
        ssl: true,
        json: true,
        xrd: true
    }, opts);

    var scheme = opts.ssl ? 'https://' : 'http://';

    var getJSON = new Promise(function (resolve, reject) {
        request(scheme + opts.host + '/.well-known/host-meta.json').spread(function (req, body) {
            resolve(JSON.parse(body));
        }).catch(reject);
    });

    var getXRD = new Promise(function (resolve, reject) {
        request(scheme + opts.host + '/.well-known/host-meta').spread(function (req, body) {
            var xrd = jxt.parse(body, XRD);
            resolve(xrd.toJSON());
        }).catch(reject);
    });


    return new Promise(function (resolve, reject) {
        Promise.some([getJSON, getXRD], 1).spread(resolve).catch(function () {
            reject('no-host-meta');
        });
    }).nodeify(cb);
};

},{"./lib/xrd":172,"bluebird":110,"jxt":204,"request":145,"underscore":222}],172:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var jxt = _dereq_('jxt');


var NS = 'http://docs.oasis-open.org/ns/xri/xrd-1.0';

var Properties = {
    get: function () {
        var results = {};
        var props = jxt.find(this.xml, NS, 'Property');
        _.each(props, function (property) {
            var type = jxt.getAttribute(property, 'type');
            results[type] = property.textContent;
        });
        return results;
    }
};

var XRD = module.exports = jxt.define({
    name: 'xrd',
    namespace: NS,
    element: 'XRD',
    fields: {
        subject: jxt.subText(NS, 'Subject'),
        expires: jxt.dateSub(NS, 'Expires'),
        aliases: jxt.multiSubText(NS, 'Alias'),
        properties: Properties
    }
});


var Link = jxt.define({
    name: 'xrdlink',
    namespace: NS,
    element: 'Link',
    fields: {
        rel: jxt.attribute('rel'),
        href: jxt.attribute('href'),
        type: jxt.attribute('type'),
        template: jxt.attribute('template'),
        titles: jxt.subLangText(NS, 'Title', 'default'),
        properties: Properties
    }
});


jxt.extend(XRD, Link, 'links');

},{"jxt":204,"underscore":222}],173:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');

var mapping = {
    md2: 'md2',
    md5: 'md5',
    'sha-1': 'sha1',
    'sha-224': 'sha224',
    'sha-256': 'sha256',
    'sha-384': 'sha384',
    'sha-512': 'sha512'
};

var names = Object.keys(mapping);


exports.getHashes = function () {
    var result = [];
    var available = crypto.getHashes();
    for (var i = 0, len = names.length; i < len; i++) {
        if (available.indexOf(mapping[names[i]]) >= 0) {
            result.push(names[i]);
        }
    }
    return result;
};

exports.createHash = function (algorithm) {
    algorithm = algorithm.toLowerCase();
    if (mapping[algorithm]) {
        algorithm = mapping[algorithm];
    }
    return crypto.createHash(algorithm);
};

exports.createHmac = function (algorithm, key) {
    algorithm = algorithm.toLowerCase();
    if (mapping[algorithm]) {
        algorithm = mapping[algorithm];
    }
    return crypto.createHmac(algorithm, key);
};

},{"crypto":177}],174:[function(_dereq_,module,exports){
module.exports=_dereq_(151)
},{"./md5":178,"buffer":148,"ripemd160":179,"sha.js":181}],175:[function(_dereq_,module,exports){
module.exports=_dereq_(152)
},{"./create-hash":174,"buffer":148}],176:[function(_dereq_,module,exports){
module.exports=_dereq_(153)
},{"buffer":148}],177:[function(_dereq_,module,exports){
module.exports=_dereq_(154)
},{"./create-hash":174,"./create-hmac":175,"./pbkdf2":185,"./rng":186,"buffer":148}],178:[function(_dereq_,module,exports){
module.exports=_dereq_(155)
},{"./helpers":176}],179:[function(_dereq_,module,exports){
module.exports=_dereq_(156)
},{"buffer":148}],180:[function(_dereq_,module,exports){
module.exports=_dereq_(157)
},{"./util":184}],181:[function(_dereq_,module,exports){
module.exports=_dereq_(158)
},{"./hash":180,"./sha1":182,"./sha256":183,"buffer":148}],182:[function(_dereq_,module,exports){
module.exports=_dereq_(159)
},{"util":169}],183:[function(_dereq_,module,exports){
module.exports=_dereq_(160)
},{"./util":184,"util":169}],184:[function(_dereq_,module,exports){
module.exports=_dereq_(161)
},{}],185:[function(_dereq_,module,exports){
module.exports=_dereq_(162)
},{"buffer":148}],186:[function(_dereq_,module,exports){
module.exports=_dereq_(163)
},{"buffer":148}],187:[function(_dereq_,module,exports){
module.exports = _dereq_('./lib/sessionManager');

},{"./lib/sessionManager":191}],188:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var bows = _dereq_('bows');
var JingleSession = _dereq_('./genericSession');
var RTCPeerConnection = _dereq_('rtcpeerconnection');
var FileTransfer = _dereq_('filetransfer');


var log = bows('JingleFile');


function FileSession(opts) {
    JingleSession.call(this, opts);

    var self = this;

    var config = this.parent.config.peerConnectionConfig;
    var constraints = this.parent.config.peerConnectionConstraints;
    config.useJingle = true;

    this.pc = new RTCPeerConnection(config, constraints);
    this.pc.on('addChannel', this._onChannelAdded.bind(this));

    this.pc.on('ice', this._onIceCandidate.bind(this));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.isInitiator) {
                self.parent.emit('iceFailed', self);
            }
            break;
        }
    });
    this.sender = new FileTransfer.Sender();
    this.sender.on('progress', function (sent, size) {
        log(self.sid + ': Send progress ' + sent + '/' + size);
    });
    this.sender.on('sentFile', function (metadata) {
        log(self.sid + ': Sent file ' + metadata.name);

        // send hash via description update
        var content = self.pc.localDescription.contents[0];
        delete content.transport;
        content.description = {
            descType: 'filetransfer',
            offer: {
                hash: {
                    algo: metadata.algo,
                    value: metadata.hash
                }
            }
        };
        self.send('description-info', { contents: [content] });
        self.parent.emit('sentFile', self, metadata);
    });

    this.receiver = new FileTransfer.Receiver();
    this.receiver.on('receivedFile', function (file) {
        self.receivedFile = file;
        self.maybeReceivedFile();
    });
    this.receiver.on('progress', function (received, size) {
        log(self.sid + ': Receive progress ' + received + '/' + size);
    });
}

util.inherits(FileSession, JingleSession);

FileSession.prototype._onChannelAdded = function (channel) {
    this.receiver.receive(null, channel);
};

FileSession.prototype = _.extend(FileSession.prototype, {
    start: function (file) {
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = true;
        var sendChannel = this.pc.createDataChannel('filetransfer');
        sendChannel.onopen = function () {
            self.sender.send(file, sendChannel);
        };

        var constraints = { mandatory: {
            OfferToReceiveAudio: false,
            OfferToReceiveVideo: false
        }};
        this.pc.offer(constraints, function (err, sessDesc) {
            // amend xep-0234 info
            sessDesc.jingle.contents[0].description = {
                descType: 'filetransfer',
                offer: {
                    date: file.lastModifiedDate,
                    //desc: '...',
                    name: file.name,
                    //range: null,
                    size: file.size,
                    hash: {
                        algo: 'sha-1',
                        value: ''
                    }
                }
            };
            self.send('session-initiate', sessDesc.jingle);
        });
    },
    end: function (reason, silence) {
        this.pc.close();
        JingleSession.prototype.end.call(this, reason, silence);
    },
    accept: function () {
        var self = this;

        log(this.sid + ': Accepted incoming session');

        this.state = 'active';
        this.pc.answer(function (err, answer) {
            if (err) {
                return log(self.sid + ': Could not create WebRTC answer', err);
            }
            // FIXME: do we need to add the 0234 parts again? whyyyyyy...

            // work around firefox...
            answer.jingle.contents[0].name = 'data';

            self.send('session-accept', answer.jingle);
        });
    },
    onSessionInitiate: function (changes, cb) {
        var self = this;

        log(self.sid + ': Initiating incoming session');

        this.state = 'pending';
        this.pc.isInitiator = false;
        // strip XEP-0234 parts
        var desc = changes.contents[0].description;
        this.receiver.metadata = desc.offer.toJSON();

        // set hash used by peer
        if (this.receiver.metadata.hash) {
            this.receiver.config.hash = this.receiver.metadata.hash.algo;
        }
        // FIXME: checks on name, size and maxiumum allowed size

        // then feed to SJJ
        changes.contents[0].description = {
            descType: 'datachannel'
        };
        this.pc.handleOffer({type: 'offer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },
    onSessionAccept: function (changes, cb) {
        var self = this;

        log(this.sid + ': Activating accepted outbound session');

        this.state = 'active';
        changes.contents[0].description = {
            descType: 'datachannel'
        };
        this.pc.handleAnswer({type: 'answer', jingle: changes}, function (err) {
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
    onDescriptionInfo: function (changes, cb) {
        // ignore anything but the value (which is the only thing that can change in a meaningful way)
        var hash = changes.contents[0].description.offer.hash;
        this.receiver.metadata.hash = hash;
        if (this.receiver.metadata.actualhash) {
            this.maybeReceivedFile();
        } else {
            // file is not yet complete
        }
        cb();
    },
    _onIceCandidate: function (candidateInfo) {
        log(this.sid + ': Discovered new ICE candidate', candidateInfo.jingle);
        candidateInfo.jingle.contents[0].name = 'data';
        this.send('transport-info', candidateInfo.jingle);
    },
    maybeReceivedFile: function () {
        if (!this.receiver.metadata.hash.value) {
            // hash not known yet
        } else if (this.receiver.metadata.hash.value === this.receiver.metadata.actualhash) {
            log(this.sid + ': Hash matches');
            this.parent.emit('receivedFile', this, this.receivedFile, this.receiver.metadata);
            this.end('success');
        } else {
            log(this.sid + ': Hash mismatch, terminating');
            this.end('media-error');
        }
    }
});

module.exports = FileSession;

},{"./genericSession":189,"bows":192,"filetransfer":194,"rtcpeerconnection":198,"underscore":222,"util":169}],189:[function(_dereq_,module,exports){
var bows = _dereq_('bows');
var async = _dereq_('async');
var WildEmitter = _dereq_('wildemitter');


var log = bows('JingleSession');


function actionToMethod(action) {
    var words = action.split('-');
    return 'on' + words[0][0].toUpperCase() + words[0].substr(1) + words[1][0].toUpperCase() + words[1].substr(1);
}

// actions defined in http://xmpp.org/extensions/xep-0166.html#def-action
var actions = [
    'content-accept', 'content-add', 'content-modify',
    'content-reject', 'content-remove', 'description-info',
    'session-accept', 'session-info', 'session-initiate',
    'session-terminate', 
    'source-add', 'source-remove', // unspecified actions, might go away anytime without notice
    'transport-accept', 'transport-info',
    'transport-reject', 'transport-replace'
];


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

        if (actions.indexOf(action) === -1) {
            log(this.sid + ': Invalid action ' + action);
            cb({condition: 'bad-request'});
            next();
            return;
        }

        var method = actionToMethod(action);
        self[method](changes, function (err) {
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
    this.processingQueue.push({
        action: action,
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
        return this._state === 'starting';
    }
});
Object.defineProperty(JingleSession.prototype, 'pending', {
    get: function () {
        return this._state === 'pending';
    }
});
Object.defineProperty(JingleSession.prototype, 'active', {
    get: function () {
        return this._state === 'active';
    }
});
Object.defineProperty(JingleSession.prototype, 'ended', {
    get: function () {
        return this._state === 'ended';
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

actions.forEach(function (action) {
    var method = actionToMethod(action);
    JingleSession.prototype[method] = function (changes, cb) {
        log(this.sid + ': Unsupported action ' + action);
        cb();
    };
});

module.exports = JingleSession;

},{"async":106,"bows":192,"wildemitter":224}],190:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var bows = _dereq_('bows');
var JingleSession = _dereq_('./genericSession');
var RTCPeerConnection = _dereq_('rtcpeerconnection');

var log = bows('JingleMedia');


function MediaSession(opts) {
    JingleSession.call(this, opts);

    var self = this;

    var config = this.parent.config.peerConnectionConfig;
    var constraints = this.parent.config.peerConnectionConstraints;
    config.useJingle = true;

    this.pc = new RTCPeerConnection(config, constraints);
    this.pc.on('ice', this._onIceCandidate.bind(this));
    this.pc.on('addStream', this._onStreamAdded.bind(this));
    this.pc.on('removeStream', this._onStreamRemoved.bind(this));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.isInitiator) {
                self.parent.emit('iceFailed', self);
            }
            break;
        }
    });
}

util.inherits(MediaSession, JingleSession);


Object.defineProperty(MediaSession.prototype, 'streams', {
    get: function () {
        return this.pc.remoteStreams;
    }
});


MediaSession.prototype = _.extend(MediaSession.prototype, {
    start: function (constraints) {
        var self = this;
        this.state = 'pending';
        this.pc.isInitiator = true;
        this.pc.offer(constraints, function (err, sessDesc) {
            // a workaround for missing a=sendonly
            // https://code.google.com/p/webrtc/issues/detail?id=1553
            if (constraints && constraints.mandatory) {
                sessDesc.jingle.contents.forEach(function (content) {
                    if (!content.description || content.description.descType !== 'rtp') {
                        return;
                    }
                    if (!constraints.mandatory.OfferToReceiveAudio &&
                            content.description.media === 'audio') {
                        content.senders = 'initiator';
                    }
                    if (!constraints.mandatory.OfferToReceiveVideo &&
                            content.description.media === 'video') {
                        content.senders = 'initiator';
                    }
                });
            }
            self.send('session-initiate', sessDesc.jingle);
        });
    },
    end: function (reason, silence) {
        var self = this;
        this.pc.close();
        _.each(this.streams, function (stream) {
            self._onStreamRemoved({stream: stream});
        });
        JingleSession.prototype.end.call(this, reason, silence);
    },
    accept: function () {
        var self = this;

        log(this.sid + ': Accepted incoming session');

        this.state = 'active';
        this.pc.answer(function (err, answer) {
            if (err) {
                return log(self.sid + ': Could not create WebRTC answer', err);
            }
            self.send('session-accept', answer.jingle);
        });
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
    addStream: function (stream) {
        this.pc.addStream(stream);
    },
    removeStream: function (stream) {
        this.pc.removeStream(stream);
    },
    onSessionInitiate: function (changes, cb) {
        var self = this;

        log(self.sid + ': Initiating incoming session');

        this.state = 'pending';
        this.pc.isInitiator = false;
        this.pc.handleOffer({type: 'offer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not create WebRTC answer', err);
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },
    onSessionAccept: function (changes, cb) {
        var self = this;

        log(this.sid + ': Activating accepted outbound session');

        this.state = 'active';
        this.pc.handleAnswer({type: 'answer', jingle: changes}, function (err) {
            if (err) {
                log(self.sid + ': Could not process WebRTC answer', err);
                return cb({condition: 'general-error'});
            }

            self.parent.emit('accepted', self);
            cb();
        });
    },
    onSessionTerminate: function (changes, cb) {
        var self = this;
        log(this.sid + ': Terminating session');
        this.pc.close();
        _.each(this.streams, function (stream) {
            self._onStreamRemoved({stream: stream});
        });
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
    onSourceAdd: function (changes, cb) {
        // note that this method is highly experimental and may 
        // go away without notice
        var self = this;

        // icky stuff that is necessary until chrome 36
        // https://code.google.com/p/webrtc/issues/detail?id=2688
        if (!this.pc || this.pc.iceConnectionState === 'closed') {
            return;
        }
        if (this.pc.iceConnectionState !== 'connected') {
            this.waitForUpdate = true;
            window.setTimeout(function () {
                self.onSourceAdd(changes, cb);
            }, 250);
            return;
        }
        if (this.waitForUpdate) {
            delete this.waitForUpdate;
            window.setTimeout(function () {
                self.onSourceAdd(changes, cb);
            }, 500);
            return;
        }
        
        log(this.sid + ': source-add');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.description;
            var ssrcs = desc.sources || [];

            changes.contents.forEach(function (newcontent) {
                if (content.name !== newcontent.name) {
                    return;
                }
                var newdesc = newcontent.description;
                var newssrcs = newdesc.sources || [];

                newDesc.contents[idx].description.sources = ssrcs.concat(newssrcs);
            });
        });

        // FIXME: this block is pretty reusable, even though sometimes the 
        // order of setRemoteDescription/setLocalDescription should change
        this.pc.handleOffer({type: 'offer', jingle: newDesc}, function (err) {
            if (err) {
                // handle error
                log(this.sid + ': source-add offer error');
                return cb({condition: 'general-error'});
            }
            self.pc.answer(function (err/*, answer*/) {
                // answer is ignored here
                if (err) {
                    log(this.sid + ': source-add answer error');
                    return cb({condition: 'general-error'});
                }
                cb();
            });
        });
    },
    onSourceRemove: function (changes, cb) {
        // note that this method is highly experimental and may 
        // go away without notice
        var self = this;

        // icky stuff that is necessary until chrome 36
        // https://code.google.com/p/webrtc/issues/detail?id=2688
        if (!this.pc || this.pc.iceConnectionState === 'closed') {
            return;
        }
        if (this.pc.iceConnectionState !== 'connected') {
            this.waitForUpdate = true;
            window.setTimeout(function () {
                self.onSourceRemove(changes, cb);
            }, 250);
            return;
        }
        if (this.waitForUpdate) {
            delete this.waitForUpdate;
            window.setTimeout(function () {
                self.onSourceRemove(changes, cb);
            }, 500);
            return;
        }

        log(this.sid + ': source-remove');

        var newDesc = this.pc.remoteDescription;
        this.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.description;
            var ssrcs = desc.sources || [];

            changes.contents.forEach(function (newcontent) {
                if (content.name !== newcontent.name) {
                    return;
                }
                var newdesc = newcontent.description;
                var newssrcs = newdesc.sources || [];

                // search the ssrc to be removed in ssrcs
                // FIXME: handle more than one newssrc
                var found = -1;
                for (var i = 0; i < ssrcs.length; i++) {
                    if (newssrcs[0].ssrc === ssrcs[i].ssrc) {
                        found = i;
                        break;
                    }
                }
                if (found > -1) {
                    ssrcs.splice(found, 1);
                    newDesc.contents[idx].description.sources = ssrcs;
                }

            });
        });
        // FIXME: this block is pretty reusable, even though sometimes the 
        // order of setRemoteDescription/setLocalDescription should change
        this.pc.handleOffer({type: 'offer', jingle: newDesc}, function (err) {
            if (err) {
                // handle error
                log(this.sid + ': source-remove offer error');
                return cb({condition: 'general-error'});
            }
            self.pc.answer(function (err/*, answer*/) {
                // answer is ignored here
                if (err) {
                    log(this.sid + ': source-remove answer error');
                    return cb({condition: 'general-error'});
                }
                cb();
            });
        });
    },
    switchStream: function (oldStream, newStream) {
        var self = this;
        // pluck the <source/> to be removed
        // which is where oldstream.label == localDescription.contents[1].description.sources[0].parameters[1].value.split(" ")[0]
        // FIXME: generate instead of deleting
        var desc = this.pc.localDescription;
        desc.contents.forEach(function (content) {
            //console.log(content.name, 'msid', content.description.sources[0].parameters[1].value.split(' ')[0]);
            delete content.transport;
            delete content.description.payloads;
        });
        console.log(JSON.parse(JSON.stringify(desc)));
        this.pc.removeStream(oldStream);
        // FIXME: send a source-remove
        this.send('source-remove', desc);

        // FIXME: does this belong here? it's rather specific to cam->screenshare
        newStream.addTrack(oldStream.getAudioTracks()[0]);

        //console.log(newStream);
        this.pc.addStream(newStream);
        this.pc.handleOffer({type: 'offer', jingle: this.pc.remoteDescription}, function (err) {
            console.log('handleOffer', err);
            self.pc.answer(function (err, answer) {
                console.log('answer', answer);
                answer.jingle.contents.forEach(function (content) {
                    //console.log('answer', content.name, 'msid', content.description.sources[0].parameters[1].value.split(' ')[0]);
                    delete content.transport;
                    delete content.description.payloads;
                });
                console.log(JSON.parse(JSON.stringify(answer.jingle)));
                // FIXME: send a source-add
                self.send('source-add', answer.jingle);
            });
        });
    },
    _onIceCandidate: function (candidateInfo) {
        log(this.sid + ': Discovered new ICE candidate', candidateInfo.jingle);
        this.send('transport-info', candidateInfo.jingle);
    },
    _onStreamAdded: function (event) {
        log(this.sid + ': Remote media stream added');

        // unfortunately, firefox does not support this yet
        /*
        event.stream.onended = function () {
            self._onStreamRemoved({stream: event.stream});
        };
        */

        this.parent.emit('peerStreamAdded', this, event.stream);
    },
    _onStreamRemoved: function (event) {
        log(this.sid + ': Remote media stream removed');
        this.parent.emit('peerStreamRemoved', this, event.stream);
    }
});


module.exports = MediaSession;

},{"./genericSession":189,"bows":192,"rtcpeerconnection":198,"underscore":222,"util":169}],191:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var bows = _dereq_('bows');
var hark = _dereq_('hark');
var webrtc = _dereq_('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');

var GenericSession = _dereq_('./genericSession');
var MediaSession = _dereq_('./mediaSession');
var FileSession = _dereq_('./fileSession');


var log = bows('Jingle');


function Jingle(opts) {
    opts = opts || {};
    var config = this.config = {
        debug: false,
        peerConnectionConfig: {
            iceServers: [{'url': 'stun:stun.l.google.com:19302'}]
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
            'urn:xmpp:jingle:apps:rtp:ssma:0',
            'urn:xmpp:jingle:apps:dtls:0',
            'urn:xmpp:jingle:apps:grouping:0',
            'urn:xmpp:jingle:apps:file-transfer:3',
            'urn:xmpp:jingle:transports:ice-udp:1',
            'urn:xmpp:jingle:transports.dtls-sctp:1',
            'urn:ietf:rfc:3264',
            'urn:ietf:rfc:5576',
            'urn:ietf:rfc:5888'
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

Jingle.prototype.setupAudioMonitor = function (stream) {
    log('Setup audio');
    var audio = hark(stream);
    var self = this;
    var timeout;

    audio.on('speaking', function () {
        if (self.hardMuted) {
            return;
        }
        self.setMicIfEnabled(1);
        self.emit('speaking');
    });

    audio.on('stopped_speaking', function () {
        if (self.hardMuted) {
            return;
        }
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(function () {
            self.setMicIfEnabled(0.5);
            self.emit('stoppedSpeaking');
        }, 1000);
    });
};

Jingle.prototype.setMicIfEnabled = function (volume) {
    if (!this.config.autoAdjustMic) {
        return;
    }
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
            if (sess && sess.pending) {
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
        } else if (contentTypes.indexOf('filetransfer') >= 0) {
            session = new FileSession(opts);
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

Jingle.prototype.createMediaSession = function (peer, sid, stream) {
    var session = new MediaSession({
        sid: sid,
        peer: peer,
        initiator: true,
        stream: stream,
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

Jingle.prototype.createFileTransferSession = function (peer, sid) {
    var session = new FileSession({
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

Jingle.prototype.endPeerSessions = function (peer, silence) {
    log('Ending all sessions with', peer);
    var sessions = this.peers[peer] || [];
    sessions.forEach(function (session) {
        session.end('gone', silence);
    });
    delete this.peers[peer];
};

Jingle.prototype.endAllPeerSessions = function () {
    log('Ending all peer sessions');
    var self = this;
    Object.keys(this.peers).forEach(function (peer) {
        self.endPeerSessions(peer);
    });
};


module.exports = Jingle;

},{"./fileSession":188,"./genericSession":189,"./mediaSession":190,"bows":192,"hark":196,"underscore":222,"webrtcsupport":203,"wildemitter":224}],192:[function(_dereq_,module,exports){
(function() {
  function checkColorSupport() {
    var chrome = !!window.chrome,
        firefox = /firefox/i.test(navigator.userAgent),
        firebug = firefox && !!window.console.exception;

    return chrome || firebug;
  }

  var inNode = typeof window === 'undefined',
      ls = !inNode && window.localStorage,
      debug = ls.debug,
      logger = _dereq_('andlog'),
      hue = 0,
      padLength = 15,
      noop = function() {},
      colorsSupported = ls.debugColors || checkColorSupport(),
      yieldColor,
      bows,
      debugRegex;

  yieldColor = function() {
    var goldenRatio = 0.618033988749895;
    hue += goldenRatio;
    hue = hue % 1;
    return hue * 360;
  };

  debugRegex = debug && debug[0]==='/' && new RegExp(debug.substring(1,debug.length-1));

  bows = function(str) {
    var msg, colorString, logfn;
    msg = (str.slice(0, padLength));
    msg += Array(padLength + 3 - msg.length).join(' ') + '|';

    if (debugRegex && !str.match(debugRegex)) return noop;

    if (colorsSupported) {
      var color = yieldColor();
      msg = "%c" + msg;
      colorString = "color: hsl(" + (color) + ",99%,40%); font-weight: bold";

      logfn = logger.log.bind(logger, msg, colorString);
      ['log', 'debug', 'warn', 'error', 'info'].forEach(function (f) {
        logfn[f] = logger[f].bind(logger, msg, colorString);
      });
    } else {
      logfn = logger.log.bind(logger, msg);
      ['log', 'debug', 'warn', 'error', 'info'].forEach(function (f) {
        logfn[f] = logger[f].bind(logger, msg);
      });
    }

    return logfn;
  };

  bows.config = function(config) {
    if (config.padLength) {
      this.padLength = config.padLength;
    }
  };

  if (typeof module !== 'undefined') {
    module.exports = bows;
  } else {
    window.bows = bows;
  }
}).call();

},{"andlog":193}],193:[function(_dereq_,module,exports){
// follow @HenrikJoreteg and @andyet if you like this ;)
(function () {
    var inNode = typeof window === 'undefined',
        ls = !inNode && window.localStorage,
        out = {};

    if (inNode) {
        module.exports = console;
        return;
    }

    var andlogKey = ls.andlogKey || 'debug'
    if (ls && ls[andlogKey] && window.console) {
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

},{}],194:[function(_dereq_,module,exports){
var async = _dereq_('async');
//var webrtcsupport = require('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');
var util = _dereq_('util');
var hashes = _dereq_('iana-hashes');

function Sender(opts) {
    WildEmitter.call(this);
    var self = this;
    var options = opts || {};
    this.config = {
        chunksize: 768,
        pacing: 10,
        hash: 'sha-1' // note: this uses iana hash names
    };
    // set our config from options
    var item;
    for (item in options) {
        this.config[item] = options[item];
    }

    this.file = null;
    this.channel = null;
    this.hash = null;

    // paced sender
    // TODO: do we have to do this?
    this.processingQueue = async.queue(function (task, next) {
        if (task.type == 'chunk') {
            var reader = new window.FileReader();
            reader.onload = (function() {
                return function(e) {
                    self.channel.send(e.target.result);

                    self.hash.update(new Uint8Array(e.target.result));

                    self.emit('progress', task.start, task.file.size);

                    window.setTimeout(next, self.config.pacing); // pacing
                };
            })(task.file);
            var slice = task.file.slice(task.start, task.start + task.size);
            reader.readAsArrayBuffer(slice);
        } else if (task.type == 'complete') {
            self.emit('sentFile', {hash: self.hash.digest('hex'), algo: self.config.hash });
            next();
        }
    });
}
util.inherits(Sender, WildEmitter);

Sender.prototype.send = function (file, channel) {
    this.file = file;
    this.hash = hashes.createHash(this.config.hash);

    this.channel = channel;
    // FIXME: hook to channel.onopen?
    for (var start = 0; start < this.file.size; start += this.config.chunksize) {
        this.processingQueue.push({
            type: 'chunk',
            file: file,
            start: start,
            size: this.config.chunksize
        });
    }
    this.processingQueue.push({
        type: 'complete'
    });
};

function Receiver(opts) {
    WildEmitter.call(this);

    var options = opts || {};
    this.config = {
        hash: 'sha-1'
    };
    // set our config from options
    var item;
    for (item in options) {
        this.config[item] = options[item];
    }
    this.receiveBuffer = [];
    this.received = 0;
    this.metadata = {};
    this.channel = null;
    this.hash = null;
}
util.inherits(Receiver, WildEmitter);

Receiver.prototype.receive = function (metadata, channel) {
    var self = this;

    if (metadata) {
        this.metadata = metadata;
    }
    this.hash = hashes.createHash(this.config.hash);

    this.channel = channel;
    // chrome only supports arraybuffers and those make it easier to calc the hash
    channel.binaryType = 'arraybuffer';
    this.channel.onmessage = function (event) {
        var len = event.data.byteLength;
        self.received += len;
        self.receiveBuffer.push(event.data);

        self.hash.update(new Uint8Array(event.data));

        self.emit('progress', self.received, self.metadata.size);
        if (self.received == self.metadata.size) {
            self.metadata.actualhash = self.hash.digest('hex');
            self.emit('receivedFile', new window.Blob(self.receiveBuffer), self.metadata);
            self.receiveBuffer = []; // discard receivebuffer
        } else if (self.received > self.metadata.size) {
            // FIXME
            console.error('received more than expected, discarding...');
            self.receiveBuffer = []; // just discard...

        }
    };
};

module.exports = {};
module.exports.support = window && window.File && window.FileReader && window.Blob;
module.exports.Sender = Sender;
module.exports.Receiver = Receiver;

},{"async":195,"iana-hashes":173,"util":169,"wildemitter":224}],195:[function(_dereq_,module,exports){
(function (process){
/*!
 * async
 * https://github.com/caolan/async
 *
 * Copyright 2010-2014 Caolan McMahon
 * Released under the MIT license
 */
/*jshint onevar: false, indent:4 */
/*global setImmediate: false, setTimeout: false, console: false */
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

    var _toString = Object.prototype.toString;

    var _isArray = Array.isArray || function (obj) {
        return _toString.call(obj) === '[object Array]';
    };

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
            async.setImmediate = function (fn) {
              // not a direct alias for IE10 compatibility
              setImmediate(fn);
            };
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
            iterator(x, only_once(done) );
        });
        function done(err) {
          if (err) {
              callback(err);
              callback = function () {};
          }
          else {
              completed += 1;
              if (completed >= arr.length) {
                  callback();
              }
          }
        }
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
                        callback();
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
        arr = _map(arr, function (x, i) {
            return {index: i, value: x};
        });
        if (!callback) {
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err) {
                    callback(err);
                });
            });
        } else {
            var results = [];
            eachfn(arr, function (x, callback) {
                iterator(x.value, function (err, v) {
                    results[x.index] = v;
                    callback(err);
                });
            }, function (err) {
                callback(err, results);
            });
        }
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
        var remainingTasks = keys.length
        if (!remainingTasks) {
            return callback();
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
            remainingTasks--
            _each(listeners.slice(0), function (fn) {
                fn();
            });
        };

        addListener(function () {
            if (!remainingTasks) {
                var theCallback = callback;
                // prevent final callback from calling itself if it errors
                callback = function () {};

                theCallback(null, results);
            }
        });

        _each(keys, function (k) {
            var task = _isArray(tasks[k]) ? tasks[k]: [tasks[k]];
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

    async.retry = function(times, task, callback) {
        var DEFAULT_TIMES = 5;
        var attempts = [];
        // Use defaults if times not passed
        if (typeof times === 'function') {
            callback = task;
            task = times;
            times = DEFAULT_TIMES;
        }
        // Make sure times is a number
        times = parseInt(times, 10) || DEFAULT_TIMES;
        var wrappedTask = function(wrappedCallback, wrappedResults) {
            var retryAttempt = function(task, finalAttempt) {
                return function(seriesCallback) {
                    task(function(err, result){
                        seriesCallback(!err || finalAttempt, {err: err, result: result});
                    }, wrappedResults);
                };
            };
            while (times) {
                attempts.push(retryAttempt(task, !(times-=1)));
            }
            async.series(attempts, function(done, data){
                data = data[data.length - 1];
                (wrappedCallback || callback)(data.err, data.result);
            });
        }
        // If a callback is passed, run this as a controll flow
        return callback ? wrappedTask() : wrappedTask
    };

    async.waterfall = function (tasks, callback) {
        callback = callback || function () {};
        if (!_isArray(tasks)) {
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
        if (_isArray(tasks)) {
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
        if (_isArray(tasks)) {
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
            var args = Array.prototype.slice.call(arguments, 1);
            if (test.apply(null, args)) {
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
            var args = Array.prototype.slice.call(arguments, 1);
            if (!test.apply(null, args)) {
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
          if (!q.started){
            q.started = true;
          }
          if (!_isArray(data)) {
              data = [data];
          }
          if(data.length == 0) {
             // call drain immediately if there are no tasks
             return async.setImmediate(function() {
                 if (q.drain) {
                     q.drain();
                 }
             });
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

              if (q.saturated && q.tasks.length === q.concurrency) {
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
            started: false,
            paused: false,
            push: function (data, callback) {
              _insert(q, data, false, callback);
            },
            kill: function () {
              q.drain = null;
              q.tasks = [];
            },
            unshift: function (data, callback) {
              _insert(q, data, true, callback);
            },
            process: function () {
                if (!q.paused && workers < q.concurrency && q.tasks.length) {
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
            },
            idle: function() {
                return q.tasks.length + workers === 0;
            },
            pause: function () {
                if (q.paused === true) { return; }
                q.paused = true;
                q.process();
            },
            resume: function () {
                if (q.paused === false) { return; }
                q.paused = false;
                q.process();
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
            drained: true,
            push: function (data, callback) {
                if (!_isArray(data)) {
                    data = [data];
                }
                _each(data, function(task) {
                    tasks.push({
                        data: task,
                        callback: typeof callback === 'function' ? callback : null
                    });
                    cargo.drained = false;
                    if (cargo.saturated && tasks.length === payload) {
                        cargo.saturated();
                    }
                });
                async.setImmediate(cargo.process);
            },
            process: function process() {
                if (working) return;
                if (tasks.length === 0) {
                    if(cargo.drain && !cargo.drained) cargo.drain();
                    cargo.drained = true;
                    return;
                }

                var ts = typeof payload === 'number'
                            ? tasks.splice(0, payload)
                            : tasks.splice(0, tasks.length);

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
                async.nextTick(function () {
                    callback.apply(null, memo[key]);
                });
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

    async.seq = function (/* functions... */) {
        var fns = arguments;
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

    async.compose = function (/* functions... */) {
      return async.seq.apply(null, Array.prototype.reverse.call(arguments));
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

    // Node.js
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = async;
    }
    // AMD / RequireJS
    else if (typeof define !== 'undefined' && define.amd) {
        define([], function () {
            return async;
        });
    }
    // included directly via <script> tag
    else {
        root.async = async;
    }

}());

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":166}],196:[function(_dereq_,module,exports){
var WildEmitter = _dereq_('wildemitter');

function getMaxVolume (analyser, fftBins) {
  var maxVolume = -Infinity;
  analyser.getFloatFrequencyData(fftBins);

  for(var i=4, ii=fftBins.length; i < ii; i++) {
    if (fftBins[i] > maxVolume && fftBins[i] < 0) {
      maxVolume = fftBins[i];
    }
  };

  return maxVolume;
}


var audioContextType = window.webkitAudioContext || window.AudioContext;
// use a single audio context due to hardware limits
var audioContext = null;
module.exports = function(stream, options) {
  var harker = new WildEmitter();


  // make it not break in non-supported browsers
  if (!audioContextType) return harker;

  //Config
  var options = options || {},
      smoothing = (options.smoothing || 0.1),
      interval = (options.interval || 50),
      threshold = options.threshold,
      play = options.play,
      history = options.history || 10,
      running = true;

  //Setup Audio Context
  if (!audioContext) {
    audioContext = new audioContextType();
  }
  var sourceNode, fftBins, analyser;

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = smoothing;
  fftBins = new Float32Array(analyser.fftSize);

  if (stream.jquery) stream = stream[0];
  if (stream instanceof HTMLAudioElement || stream instanceof HTMLVideoElement) {
    //Audio Tag
    sourceNode = audioContext.createMediaElementSource(stream);
    if (typeof play === 'undefined') play = true;
    threshold = threshold || -50;
  } else {
    //WebRTC Stream
    sourceNode = audioContext.createMediaStreamSource(stream);
    threshold = threshold || -50;
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
  
  harker.stop = function() {
    running = false;
    harker.emit('volume_change', -100, threshold);
    if (harker.speaking) {
      harker.speaking = false;
      harker.emit('stopped_speaking');
    }
  };
  harker.speakingHistory = [];
  for (var i = 0; i < history; i++) {
      harker.speakingHistory.push(0);
  }

  // Poll the analyser node to determine if speaking
  // and emit events if changed
  var looper = function() {
    setTimeout(function() {
    
      //check if stop has been called
      if(!running) {
        return;
      }
      
      var currentVolume = getMaxVolume(analyser, fftBins);

      harker.emit('volume_change', currentVolume, threshold);

      var history = 0;
      if (currentVolume > threshold && !harker.speaking) {
        // trigger quickly, short history
        for (var i = harker.speakingHistory.length - 3; i < harker.speakingHistory.length; i++) {
          history += harker.speakingHistory[i];
        }
        if (history >= 2) {
          harker.speaking = true;
          harker.emit('speaking');
        }
      } else if (currentVolume < threshold && harker.speaking) {
        for (var i = 0; i < harker.speakingHistory.length; i++) {
          history += harker.speakingHistory[i];
        }
        if (history == 0) {
          harker.speaking = false;
          harker.emit('stopped_speaking');
        }
      }
      harker.speakingHistory.shift();
      harker.speakingHistory.push(0 + (currentVolume > threshold));

      looper();
    }, interval);
  };
  looper();


  return harker;
}

},{"wildemitter":224}],197:[function(_dereq_,module,exports){
// based on https://github.com/ESTOS/strophe.jingle/
// adds wildemitter support
var util = _dereq_('util');
var webrtc = _dereq_('webrtcsupport');
var WildEmitter = _dereq_('wildemitter');

function dumpSDP(description) {
    return 'type: ' + description.type + '\r\n' + description.sdp;
}

function TraceablePeerConnection(config, constraints) {
    var self = this;
    WildEmitter.call(this);

    this.peerconnection = new webrtc.PeerConnection(config, constraints);

    this.trace = function (what, info) {
        self.emit('PeerConnectionTrace', {
            time: new Date(),
            type: what,
            value: info || ""
        });
    };

    this.onicecandidate = null;
    this.peerconnection.onicecandidate = function (event) {
        self.trace('onicecandidate', JSON.stringify(event.candidate, null, ' '));
        if (self.onicecandidate !== null) {
            self.onicecandidate(event);
        }
    };
    this.onaddstream = null;
    this.peerconnection.onaddstream = function (event) {
        self.trace('onaddstream', event.stream.id);
        if (self.onaddstream !== null) {
            self.onaddstream(event);
        }
    };
    this.onremovestream = null;
    this.peerconnection.onremovestream = function (event) {
        self.trace('onremovestream', event.stream.id);
        if (self.onremovestream !== null) {
            self.onremovestream(event);
        }
    };
    this.onsignalingstatechange = null;
    this.peerconnection.onsignalingstatechange = function (event) {
        self.trace('onsignalingstatechange', self.signalingState);
        if (self.onsignalingstatechange !== null) {
            self.onsignalingstatechange(event);
        }
    };
    this.oniceconnectionstatechange = null;
    this.peerconnection.oniceconnectionstatechange = function (event) {
        self.trace('oniceconnectionstatechange', self.iceConnectionState);
        if (self.oniceconnectionstatechange !== null) {
            self.oniceconnectionstatechange(event);
        }
    };
    this.onnegotiationneeded = null;
    this.peerconnection.onnegotiationneeded = function (event) {
        self.trace('onnegotiationneeded');
        if (self.onnegotiationneeded !== null) {
            self.onnegotiationneeded(event);
        }
    };
    self.ondatachannel = null;
    this.peerconnection.ondatachannel = function (event) {
        self.trace('ondatachannel', event);
        if (self.ondatachannel !== null) {
            self.ondatachannel(event);
        }
    };
    this.getLocalStreams = this.peerconnection.getLocalStreams.bind(this.peerconnection);
    this.getRemoteStreams = this.peerconnection.getRemoteStreams.bind(this.peerconnection);
}

util.inherits(TraceablePeerConnection, WildEmitter);

Object.defineProperty(TraceablePeerConnection.prototype, 'signalingState', {
    get: function () {
        return this.peerconnection.signalingState;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'iceConnectionState', {
    get: function () {
        return this.peerconnection.iceConnectionState;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'localDescription', {
    get: function () {
        return this.peerconnection.localDescription;
    }
});

Object.defineProperty(TraceablePeerConnection.prototype, 'remoteDescription', {
    get: function () {
        return this.peerconnection.remoteDescription;
    }
});

TraceablePeerConnection.prototype.addStream = function (stream) {
    this.trace('addStream', stream.id);
    this.peerconnection.addStream(stream);
};

TraceablePeerConnection.prototype.removeStream = function (stream) {
    this.trace('removeStream', stream.id);
    this.peerconnection.removeStream(stream);
};

TraceablePeerConnection.prototype.createDataChannel = function (label, opts) {
    this.trace('createDataChannel', label, opts);
    return this.peerconnection.createDataChannel(label, opts);
};

TraceablePeerConnection.prototype.setLocalDescription = function (description, successCallback, failureCallback) {
    var self = this;
    this.trace('setLocalDescription', dumpSDP(description));
    this.peerconnection.setLocalDescription(description,
        function () {
            self.trace('setLocalDescriptionOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('setLocalDescriptionOnFailure', err);
            failureCallback(err);
        }
    );
};

TraceablePeerConnection.prototype.setRemoteDescription = function (description, successCallback, failureCallback) {
    var self = this;
    this.trace('setRemoteDescription', dumpSDP(description));
    this.peerconnection.setRemoteDescription(description,
        function () {
            self.trace('setRemoteDescriptionOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('setRemoteDescriptionOnFailure', err);
            failureCallback(err);
        }
    );
};

TraceablePeerConnection.prototype.close = function () {
    this.trace('stop');
    if (this.statsinterval !== null) {
        window.clearInterval(this.statsinterval);
        this.statsinterval = null;
    }
    if (this.peerconnection.signalingState != 'closed') {
        this.peerconnection.close();
    }
};

TraceablePeerConnection.prototype.createOffer = function (successCallback, failureCallback, constraints) {
    var self = this;
    this.trace('createOffer', JSON.stringify(constraints, null, ' '));
    this.peerconnection.createOffer(
        function (offer) {
            self.trace('createOfferOnSuccess', dumpSDP(offer));
            successCallback(offer);
        },
        function (err) {
            self.trace('createOfferOnFailure', err);
            failureCallback(err);
        },
        constraints
    );
};

TraceablePeerConnection.prototype.createAnswer = function (successCallback, failureCallback, constraints) {
    var self = this;
    this.trace('createAnswer', JSON.stringify(constraints, null, ' '));
    this.peerconnection.createAnswer(
        function (answer) {
            self.trace('createAnswerOnSuccess', dumpSDP(answer));
            successCallback(answer);
        },
        function (err) {
            self.trace('createAnswerOnFailure', err);
            failureCallback(err);
        },
        constraints
    );
};

TraceablePeerConnection.prototype.addIceCandidate = function (candidate, successCallback, failureCallback) {
    var self = this;
    this.trace('addIceCandidate', JSON.stringify(candidate, null, ' '));
    this.peerconnection.addIceCandidate(candidate);
    /* maybe later
    this.peerconnection.addIceCandidate(candidate, 
        function () {                                
            self.trace('addIceCandidateOnSuccess');
            successCallback();
        },
        function (err) {
            self.trace('addIceCandidateOnFailure', err);
            failureCallback(err);
        }
    );
    */
};

TraceablePeerConnection.prototype.getStats = function (callback, errback) {
    if (navigator.mozGetUserMedia) {
        this.peerconnection.getStats(null, callback, errback);
    } else {
        this.peerconnection.getStats(callback);
    }
};

module.exports = TraceablePeerConnection;

},{"util":169,"webrtcsupport":203,"wildemitter":224}],198:[function(_dereq_,module,exports){
var _ = _dereq_('underscore');
var util = _dereq_('util');
var webrtc = _dereq_('webrtcsupport');
var SJJ = _dereq_('sdp-jingle-json');
var WildEmitter = _dereq_('wildemitter');
var peerconn = _dereq_('traceablepeerconnection');

function PeerConnection(config, constraints) {
    var self = this;
    var item;
    WildEmitter.call(this);

    config = config || {};
    config.iceServers = config.iceServers || [];

    this.pc = new peerconn(config, constraints);

    this.getLocalStreams = this.pc.getLocalStreams.bind(this.pc);
    this.getRemoteStreams = this.pc.getRemoteStreams.bind(this.pc);
    this.addStream = this.pc.addStream.bind(this.pc);
    this.removeStream = this.pc.removeStream.bind(this.pc);

    // proxy events 
    this.pc.on('*', function () {
        self.emit.apply(self, arguments);
    });

    // proxy some events directly
    this.pc.onremovestream = this.emit.bind(this, 'removeStream');
    this.pc.onnegotiationneeded = this.emit.bind(this, 'negotiationNeeded');
    this.pc.oniceconnectionstatechange = this.emit.bind(this, 'iceConnectionStateChange');
    this.pc.onsignalingstatechange = this.emit.bind(this, 'signalingStateChange');

    // handle incoming ice and data channel events
    this.pc.onaddstream = this._onAddStream.bind(this);
    this.pc.onicecandidate = this._onIce.bind(this);
    this.pc.ondatachannel = this._onDataChannel.bind(this);

    this.localDescription = {
        contents: []
    };
    this.remoteDescription = {
        contents: []
    };

    this.localStream = null;
    this.remoteStreams = [];

    this.config = {
        debug: false,
        ice: {},
        sid: '',
        isInitiator: true,
        sdpSessionID: Date.now(),
        useJingle: false
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
    this.hadLocalStunCandidate = false;
    this.hadRemoteStunCandidate = false;
    this.hadLocalRelayCandidate = false;
    this.hadRemoteRelayCandidate = false;
}

util.inherits(PeerConnection, WildEmitter);

Object.defineProperty(PeerConnection.prototype, 'signalingState', {
    get: function () {
        return this.pc.signalingState;
    }
});
Object.defineProperty(PeerConnection.prototype, 'iceConnectionState', {
    get: function () {
        return this.pc.iceConnectionState;
    }
});

// Add a stream to the peer connection object
PeerConnection.prototype.addStream = function (stream) {
    this.localStream = stream;
    this.pc.addStream(stream);
};


// Init and add ice candidate object with correct constructor
PeerConnection.prototype.processIce = function (update, cb) {
    cb = cb || function () {};
    var self = this;

    if (update.contents) {
        var contentNames = _.pluck(this.remoteDescription.contents, 'name');
        var contents = update.contents;

        contents.forEach(function (content) {
            var transport = content.transport || {};
            var candidates = transport.candidates || [];
            var mline = contentNames.indexOf(content.name);
            var mid = content.name;

            candidates.forEach(function (candidate) {
                var iceCandidate = SJJ.toCandidateSDP(candidate) + '\r\n';
                self.pc.addIceCandidate(new webrtc.IceCandidate({
                    candidate: iceCandidate,
                    sdpMLineIndex: mline,
                    sdpMid: mid
                })
                /* not yet, breaks Chrome M32 */
                /*
                , function () {
                    // well, this success callback is pretty meaningless
                },
                function (err) {
                    self.emit('error', err);
                }
                */
                );
                if (candidate.type === 'srflx') {
                    self.hadRemoteStunCandidate = true;
                }
                else if (candidate.type === 'relay') {
                    self.hadRemoteRelayCandidate = true;
                }
            });
        });
    } else {
        self.pc.addIceCandidate(new webrtc.IceCandidate(update.candidate));
        if (update.candidate.candidate.indexOf('typ srflx') !== -1) {
            self.hadRemoteStunCandidate = true;
        }
        else if (update.candidate.candidate.indexOf('typ relay') !== -1) {
            self.hadRemoteRelayCandidate = true;
        }
    }
    cb();
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
    cb = hasConstraints ? cb : constraints;
    cb = cb || function () {};

    // Actually generate the offer
    this.pc.createOffer(
        function (offer) {
            self.pc.setLocalDescription(offer,
                function () {
                    var jingle;
                    var expandedOffer = {
                        type: 'offer',
                        sdp: offer.sdp
                    };
                    if (self.config.useJingle) {
                        jingle = SJJ.toSessionJSON(offer.sdp, self.config.isInitiator ? 'initiator' : 'responder');
                        jingle.sid = self.config.sid;
                        self.localDescription = jingle;

                        // Save ICE credentials
                        _.each(jingle.contents, function (content) {
                            var transport = content.transport || {};
                            if (transport.ufrag) {
                                self.config.ice[content.name] = {
                                    ufrag: transport.ufrag,
                                    pwd: transport.pwd
                                };
                            }
                        });

                        expandedOffer.jingle = jingle;
                    }

                    self.emit('offer', expandedOffer);
                    cb(null, expandedOffer);
                },
                function (err) {
                    self.emit('error', err);
                    cb(err);
                }
            );
        },
        function (err) {
            self.emit('error', err);
            cb(err);
        },
        mediaConstraints
    );
};


// Process an incoming offer so that ICE may proceed before deciding
// to answer the request.
PeerConnection.prototype.handleOffer = function (offer, cb) {
    cb = cb || function () {};
    var self = this;
    offer.type = 'offer';
    if (offer.jingle) {
        offer.sdp = SJJ.toSessionSDP(offer.jingle, self.config.sdpSessionID);
        self.remoteDescription = offer.jingle;
    }
    self.pc.setRemoteDescription(new webrtc.SessionDescription(offer), function () {
        cb();
    }, cb);
};

// Answer an offer with audio only
PeerConnection.prototype.answerAudioOnly = function (cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: false
            }
        };
    this._answer(mediaConstraints, cb);
};

// Answer an offer without offering to recieve
PeerConnection.prototype.answerBroadcastOnly = function (cb) {
    var mediaConstraints = {
            mandatory: {
                OfferToReceiveAudio: false,
                OfferToReceiveVideo: false
            }
        };
    this._answer(mediaConstraints, cb);
};

// Answer an offer with given constraints default is audio/video
PeerConnection.prototype.answer = function (constraints, cb) {
    var self = this;
    var hasConstraints = arguments.length === 2;
    var callback = hasConstraints ? cb : constraints;
    var mediaConstraints = hasConstraints ? constraints : {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

    this._answer(mediaConstraints, callback);
};

// Process an answer
PeerConnection.prototype.handleAnswer = function (answer, cb) {
    cb = cb || function () {};
    var self = this;
    if (answer.jingle) {
        answer.sdp = SJJ.toSessionSDP(answer.jingle, self.config.sdpSessionID);
        self.remoteDescription = answer.jingle;
    }
    self.pc.setRemoteDescription(
        new webrtc.SessionDescription(answer),
        function () {
            cb(null);
        },
        cb
    );
};

// Close the peer connection
PeerConnection.prototype.close = function () {
    this.pc.close();
    this.emit('close');
};

// Internal code sharing for various types of answer methods
PeerConnection.prototype._answer = function (constraints, cb) {
    cb = cb || function () {};
    var self = this;
    if (!this.pc.remoteDescription) {
        // the old API is used, call handleOffer
        throw new Error('remoteDescription not set');
    }
    self.pc.createAnswer(
        function (answer) {
            self.pc.setLocalDescription(answer,
                function () {
                    var expandedAnswer = {
                        type: 'answer',
                        sdp: answer.sdp
                    };
                    if (self.config.useJingle) {
                        var jingle = SJJ.toSessionJSON(answer.sdp);
                        jingle.sid = self.config.sid;
                        self.localDescription = jingle;
                        expandedAnswer.jingle = jingle;
                    }
                    self.emit('answer', expandedAnswer);
                    cb(null, expandedAnswer);
                },
                function (err) {
                    self.emit('error', err);
                    cb(err);
                }
            );
        },
        function (err) {
            self.emit('error', err);
            cb(err);
        },
        constraints
    );
};

// Internal method for emitting ice candidates on our peer object
PeerConnection.prototype._onIce = function (event) {
    var self = this;
    if (event.candidate) {
        var ice = event.candidate;

        var expandedCandidate = {
            candidate: event.candidate
        };

        if (self.config.useJingle) {
            if (!ice.sdpMid) { // firefox doesn't set this
                ice.sdpMid = self.localDescription.contents[ice.sdpMLineIndex].name;
            }
            if (!self.config.ice[ice.sdpMid]) {
                var jingle = SJJ.toSessionJSON(self.pc.localDescription.sdp, self.config.isInitiator ? 'initiator' : 'responder');
                _.each(jingle.contents, function (content) {
                    var transport = content.transport || {};
                    if (transport.ufrag) {
                        self.config.ice[content.name] = {
                            ufrag: transport.ufrag,
                            pwd: transport.pwd
                        };
                    }
                });
            }
            expandedCandidate.jingle = {
                contents: [{
                    name: ice.sdpMid,
                    creator: self.config.isInitiator ? 'initiator' : 'responder',
                    transport: {
                        transType: 'iceUdp',
                        ufrag: self.config.ice[ice.sdpMid].ufrag,
                        pwd: self.config.ice[ice.sdpMid].pwd,
                        candidates: [
                            SJJ.toCandidateJSON(ice.candidate)
                        ]
                    }
                }]
            };
        }
        if (ice.candidate.indexOf('typ srflx') !== -1) {
            this.hadLocalStunCandidate = true;
        }
        else if (ice.candidate.indexOf('typ relay') !== -1) {
            this.hadLocalRelayCandidate = true;
        }

        this.emit('ice', expandedCandidate);
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
    this.remoteStreams.push(event.stream);
    this.emit('addStream', event);
};

// Create a data channel spec reference:
// http://dev.w3.org/2011/webrtc/editor/webrtc.html#idl-def-RTCDataChannelInit
PeerConnection.prototype.createDataChannel = function (name, opts) {
    var channel = this.pc.createDataChannel(name, opts);
    return channel;
};

// a wrapper around getStats which hides the differences (where possible)
PeerConnection.prototype.getStats = function (cb) {
    if (webrtc.prefix === 'moz') {
        this.pc.getStats(
            function (res) {
                var items = [];
                res.forEach(function (result) {
                    items.push(result);
                });
                cb(null, items);
            },
            cb
        );
    } else {
        this.pc.getStats(function (res) {
            var items = [];
            res.result().forEach(function (result) {
                var item = {};
                result.names().forEach(function (name) {
                    item[name] = result.stat(name);
                });
                item.id = result.id;
                item.type = result.type;
                item.timestamp = result.timestamp;
                items.push(item);
            });
            cb(null, items);
        });
    }
};

module.exports = PeerConnection;

},{"sdp-jingle-json":199,"traceablepeerconnection":197,"underscore":222,"util":169,"webrtcsupport":203,"wildemitter":224}],199:[function(_dereq_,module,exports){
var tosdp = _dereq_('./lib/tosdp');
var tojson = _dereq_('./lib/tojson');


exports.toSessionSDP = tosdp.toSessionSDP;
exports.toMediaSDP = tosdp.toMediaSDP;
exports.toCandidateSDP = tosdp.toCandidateSDP;

exports.toSessionJSON = tojson.toSessionJSON;
exports.toMediaJSON = tojson.toMediaJSON;
exports.toCandidateJSON = tojson.toCandidateJSON;

},{"./lib/tojson":201,"./lib/tosdp":202}],200:[function(_dereq_,module,exports){
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

exports.sctpmap = function (line) {
    // based on -05 draft
    var parts = line.substr(10).split(' ');
    var parsed = {
        number: parts.shift(),
        protocol: parts.shift(),
        streams: parts.shift()
    };
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
        parsed.senders = idpart.substr(sp + 1);
    } else {
        parsed.id = idpart;
        parsed.senders = 'sendrecv';
    }

    parsed.uri = parts.shift() || '';

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
        parsed.subtype = parts.shift() || '';
    }
    parsed.parameters = parts;
    return parsed;
};

exports.candidate = function (line) {
    var parts;
    if (line.indexOf('a=candidate:') === 0) {
        parts = line.substring(12).split(' ');
    } else { // no a=candidate
        parts = line.substring(10).split(' ');
    }

    var candidate = {
        foundation: parts[0],
        component: parts[1],
        protocol: parts[2].toLowerCase(),
        priority: parts[3],
        ip: parts[4],
        port: parts[5],
        // skip parts[6] == 'typ'
        type: parts[7],
        generation: '0'
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

exports.sourceGroups = function (lines) {
    var parsed = [];
    for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].substr(13).split(' ');
        parsed.push({
            semantics: parts.shift(),
            sources: parts
        });
    }
    return parsed;
};

exports.sources = function (lines) {
    // http://tools.ietf.org/html/rfc5576
    var parsed = [];
    var sources = {};
    for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].substr(7).split(' ');
        var ssrc = parts.shift();

        if (!sources[ssrc]) {
            var source = {
                ssrc: ssrc,
                parameters: []
            };
            parsed.push(source);

            // Keep an index
            sources[ssrc] = source;
        }

        parts = parts.join(' ').split(':');
        var attribute = parts.shift();
        var value = parts.join(':') || null;

        sources[ssrc].parameters.push({
            key: attribute,
            value: value
        });
    }

    return parsed;
};

exports.groups = function (lines) {
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

},{}],201:[function(_dereq_,module,exports){
var parsers = _dereq_('./parsers');
var idCounter = Math.random();

exports._setIdCounter = function (counter) {
    idCounter = counter;
};

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
        parsed.groups = parsers.groups(groupLines);
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
            fingerprints: [],
        }
    };
    if (mline.media == 'application') {
        // FIXME: the description is most likely to be independent
        // of the SDP and should be processed by other parts of the library
        content.description = {
            descType: 'datachannel'
        };
        content.transport.sctp = [];
    }
    var desc = content.description;
    var trans = content.transport;

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

    if (desc.descType == 'rtp') {
        var ssrc = parsers.findLine('a=ssrc:', lines);
        if (ssrc) {
            desc.ssrc = ssrc.substr(7).split(' ')[0];
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

        var ssrcGroupLines = parsers.findLines('a=ssrc-group:', lines);
        desc.sourceGroups = parsers.sourceGroups(ssrcGroupLines || []);

        var ssrcLines = parsers.findLines('a=ssrc:', lines);
        desc.sources = parsers.sources(ssrcLines || []);
    }

    // transport specific attributes
    var fingerprintLines = parsers.findLines('a=fingerprint:', lines, sessionLines);
    fingerprintLines.forEach(function (line) {
        var fp = parsers.fingerprint(line);
        var setup = parsers.findLine('a=setup:', lines, sessionLines);
        if (setup) {
            fp.setup = setup.substr(8);
        }
        trans.fingerprints.push(fp);
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

    if (desc.descType == 'datachannel') {
        var sctpmapLines = parsers.findLines('a=sctpmap:', lines);
        sctpmapLines.forEach(function (line) {
            var sctp = parsers.sctpmap(line);
            trans.sctp.push(sctp);
        });
    }

    return content;
};

exports.toCandidateJSON = function (line) {
    var candidate = parsers.candidate(line.split('\r\n')[0]);
    candidate.id = (idCounter++).toString(36).substr(0, 12);
    return candidate;
};

},{"./parsers":200}],202:[function(_dereq_,module,exports){
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


exports.toSessionSDP = function (session, sid, time) {
    var sdp = [
        'v=0',
        'o=- ' + (sid || session.sid || Date.now()) + ' ' + (time || Date.now()) + ' IN IP4 0.0.0.0',
        's=-',
        't=0 0'
    ];

    var groups = session.groups || [];
    groups.forEach(function (group) {
        sdp.push('a=group:' + group.semantics + ' ' + group.contents.join(' '));
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

    var mline = [];
    if (desc.descType == 'datachannel') {
        mline.push('application');
        mline.push('1');
        mline.push('DTLS/SCTP');
        if (transport.sctp) {
            transport.sctp.forEach(function (map) {
                mline.push(map.number);
            });
        }
    } else {
        mline.push(desc.media);
        mline.push('1');
        if ((desc.encryption && desc.encryption.length > 0) || (fingerprints.length > 0)) {
            mline.push('RTP/SAVPF');
        } else {
            mline.push('RTP/AVPF');
        }
        payloads.forEach(function (payload) {
            mline.push(payload.id);
        });
    }


    sdp.push('m=' + mline.join(' '));

    sdp.push('c=IN IP4 0.0.0.0');
    if (desc.descType == 'rtp') {
        sdp.push('a=rtcp:1 IN IP4 0.0.0.0');
    }

    if (transport) {
        if (transport.ufrag) {
            sdp.push('a=ice-ufrag:' + transport.ufrag);
        }
        if (transport.pwd) {
            sdp.push('a=ice-pwd:' + transport.pwd);
        }
        if (transport.setup) {
            sdp.push('a=setup:' + transport.setup);
        }
        fingerprints.forEach(function (fingerprint) {
            sdp.push('a=fingerprint:' + fingerprint.hash + ' ' + fingerprint.value);
        });
        if (transport.sctp) {
            transport.sctp.forEach(function (map) {
                sdp.push('a=sctpmap:' + map.number + ' ' + map.protocol + ' ' + map.streams);
            });
        }
    }

    if (desc.descType == 'rtp') {
        sdp.push('a=' + (senders[content.senders] || 'sendrecv'));
    }
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

    var ssrcGroups = desc.sourceGroups || [];
    ssrcGroups.forEach(function (ssrcGroup) {
        sdp.push('a=ssrc-group:' + ssrcGroup.semantics + ' ' + ssrcGroup.sources.join(' '));
    });

    var ssrcs = desc.sources || [];
    ssrcs.forEach(function (ssrc) {
        for (var i = 0; i < ssrc.parameters.length; i++) {
            var param = ssrc.parameters[i];
            sdp.push('a=ssrc:' + (ssrc.ssrc || desc.ssrc) + ' ' + param.key + (param.value ? (':' + param.value) : ''));
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
    sdp.push(candidate.protocol.toUpperCase());
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

    // FIXME: apparently this is wrong per spec
    // but then, we need this when actually putting this into
    // SDP so it's going to stay.
    // decision needs to be revisited when browsers dont
    // accept this any longer
    return 'a=candidate:' + sdp.join(' ');
};

},{}],203:[function(_dereq_,module,exports){
// created by @HenrikJoreteg
var prefix;
var isChrome = false;
var isFirefox = false;
var ua = window.navigator.userAgent.toLowerCase();

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
var screenSharing = window.location.protocol === 'https:' && window.navigator.userAgent.match('Chrome') && parseInt(window.navigator.userAgent.match(/Chrome\/(.*) /)[1], 10) >= 26;
var AudioContext = window.webkitAudioContext || window.AudioContext;


// export support flags and constructors.prototype && PC
module.exports = {
    support: !!PC,
    dataChannel: isChrome || isFirefox || (PC && PC.prototype && PC.prototype.createDataChannel),
    prefix: prefix,
    webAudio: !!(AudioContext && AudioContext.prototype.createMediaStreamSource),
    mediaStream: !!(MediaStream && MediaStream.prototype.removeTrack),
    screenSharing: !!screenSharing,
    AudioContext: AudioContext,
    PeerConnection: PC,
    SessionDescription: SessionDescription,
    IceCandidate: IceCandidate
};

},{}],204:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var core = _dereq_('./lib/core');
var helpers = _dereq_('./lib/helpers');
var types = _dereq_('./lib/types');

module.exports = _.extend({}, core, helpers, types);

},{"./lib/core":205,"./lib/helpers":206,"./lib/types":207,"underscore":222}],205:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var xmlshim = _dereq_('ltx-dom-shim');

var helpers = _dereq_('./helpers');
var types = _dereq_('./types');

var LOOKUP = {};
var LOOKUP_EXT = {};
var TOP_LEVEL_LOOKUP = {};


function topLevel(JXT) {
    var name = JXT.prototype._NS + '|' + JXT.prototype._EL;
    LOOKUP[name] = JXT;
    TOP_LEVEL_LOOKUP[name] = JXT;
}

function toString(xml) {
    return xmlshim.serializeToString(xml);
}

function toJSON(jxt) {
    var prop;
    var result = {};
    var exclude = {
        constructor: true,
        _EL: true,
        _NS: true,
        _extensions: true,
        _name: true,
        parent: true,
        prototype: true,
        toJSON: true,
        toString: true,
        xml: true
    };

    for (prop in jxt._extensions) {
        if (jxt._extensions[prop].toJSON && prop[0] !== '_') {
            result[prop] = jxt._extensions[prop].toJSON();
        }
    }

    for (prop in jxt) {
        if (!exclude[prop] && !((LOOKUP_EXT[jxt._NS + '|' + jxt._EL] || {})[prop]) && !jxt._extensions[prop] && prop[0] !== '_') {
            var val = jxt[prop];
            if (typeof val === 'function') {
                continue;
            }
            var type = Object.prototype.toString.call(val);
            if (type.indexOf('Object') >= 0) {
                if (Object.keys(val).length > 0) {
                    result[prop] = val;
                }
            } else if (type.indexOf('Array') >= 0) {
                if (val.length > 0) {
                    var vals = [];
                    for (var n in val) {
                        var nval = val[n];
                        vals.push(nval.toJSON !== undefined ? nval.toJSON() : nval);
                    }
                    result[prop] = vals;
                }
            } else if (val !== undefined && val !== false && val !== '') {
                result[prop] = val;
            }
        }
    }

    return result;
}


exports.build = function (xml) {
    var JXT = TOP_LEVEL_LOOKUP[xml.namespaceURI + '|' + xml.localName];
    if (JXT) {
        return new JXT(null, xml);
    }
};


exports.parse = function (str, JXT, lookupContext) {
    lookupContext = lookupContext || TOP_LEVEL_LOOKUP;
    var nodes = xmlshim.parseFromString(str, 'application/xml').childNodes;
    for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].nodeType === 1) {
            // Check for parse errors because browsers are stupid
            if (nodes[i].nodeName === 'parsererror') {
                // Matches Firefox parse error
                throw new Error({name: 'parsererror', message: 'Could not parse: ' + str});
            } else if (nodes[i].childElementCount > 0 && nodes[i].childNodes[0].nodeName === 'parsererror') {
                // Matches Webkit parse error
                throw new Error({name: 'parsererror', message: 'Could not parse: ' + str});
            }

            var xml = nodes[i];
            if (JXT) {
                return new JXT(null, xml);
            } else {
                JXT = lookupContext[xml.namespaceURI + '|' + xml.localName];
                return new JXT(null, xml);
            }
        }
    }
    throw new Error({name: 'parsererror', message: 'Could not parse: ' + str});
};


exports.extend = function (ParentJXT, ChildJXT, multiName) {
    var parentName = ParentJXT.prototype._NS + '|' + ParentJXT.prototype._EL;
    var name = ChildJXT.prototype._name;
    var qName = ChildJXT.prototype._NS + '|' + ChildJXT.prototype._EL;

    LOOKUP[qName] = ChildJXT;
    if (!LOOKUP_EXT[qName]) {
        LOOKUP_EXT[qName] = {};
    }
    if (!LOOKUP_EXT[parentName]) {
        LOOKUP_EXT[parentName] = {};
    }
    LOOKUP_EXT[parentName][name] = ChildJXT;

    exports.add(ParentJXT, name, types.extension(ChildJXT));
    if (multiName) {
        exports.add(ParentJXT, multiName, types.multiExtension(ChildJXT));
    }
};

exports.add = function (ParentJXT, fieldName, field) {
    field.enumerable = true;
    Object.defineProperty(ParentJXT.prototype, fieldName, field);
};

exports.define = function (opts) {
    var StanzaConstructor = function (data, xml, parent) {
        var self = this;

        var parentNode = (xml || {}).parentNode || (parent || {}).xml;
        var parentNS = (parentNode || {}).namespaceURI;

        self.xml = xml || helpers.createElement(self._NS, self._EL, parentNS);

        _.each(opts.prefixes || {}, function (namespace, prefix) {
            self.xml.setAttribute('xmlns:' + prefix, namespace);
        });

        self._extensions = {};

        _.each(self.xml.childNodes, function (child) {
            var childName = child.namespaceURI + '|' + child.localName;
            var ChildJXT = LOOKUP[childName];
            if (ChildJXT !== undefined) {
                var name = ChildJXT.prototype._name;
                self._extensions[name] = new ChildJXT(null, child);
                self._extensions[name].parent = self;
            }
        });

        _.extend(self, data);

        if (opts.init) {
            opts.init.apply(self, [data]);
        }

        return self;
    };

    StanzaConstructor.prototype = {
        constructor: {
            value: StanzaConstructor
        },
        _name: opts.name,
        _eventname: opts.eventName,
        _NS: opts.namespace,
        _EL: opts.element,
        toString: function () { return toString(this.xml); },
        toJSON: function () { return toJSON(this); }
    };

    var fieldNames = Object.keys(opts.fields || {});
    fieldNames.forEach(function (fieldName) {
        exports.add(StanzaConstructor, fieldName, opts.fields[fieldName]);
    });

    if (opts.topLevel) {
        topLevel(StanzaConstructor);
    }

    return StanzaConstructor;
};

},{"./helpers":206,"./types":207,"ltx-dom-shim":208,"underscore":222}],206:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var xmlshim = _dereq_('ltx-dom-shim');

var XML_NS = exports.XML_NS = 'http://www.w3.org/XML/1998/namespace';


exports.createElement = function (NS, name, parentNS) {
    var el = xmlshim.createElementNS(NS, name);
    if (!parentNS || parentNS !== NS) {
        exports.setAttribute(el, 'xmlns', NS);
    }
    return el;
};

var find = exports.find = function (xml, NS, selector) {
    var children = xml.getElementsByTagName(selector);
    return _.filter(children, function (child) {
        return child.namespaceURI === NS && child.parentNode === xml;
    });
};

exports.findOrCreate = function (xml, NS, selector) {
    var existing = exports.find(xml, NS, selector);
    if (existing.length) {
        return existing[0];
    } else {
        var created = exports.createElement(NS, selector, xml.namespaceURI);
        xml.appendChild(created);
        return created;
    }
};

exports.getAttribute = function (xml, attr, defaultVal) {
    return xml.getAttribute(attr) || defaultVal || '';
};

exports.getAttributeNS = function (xml, NS, attr, defaultVal) {
    return xml.getAttributeNS(NS, attr) || defaultVal || '';
};

exports.setAttribute = function (xml, attr, value, force) {
    if (value || force) {
        xml.setAttribute(attr, value);
    } else {
        xml.removeAttribute(attr);
    }
};

exports.setAttributeNS = function (xml, NS, attr, value, force) {
    if (value || force) {
        xml.setAttributeNS(NS, attr, value);
    } else {
        xml.removeAttributeNS(NS, attr);
    }
};

exports.getBoolAttribute = function (xml, attr, defaultVal) {
    var val = xml.getAttribute(attr) || defaultVal || '';
    return val === 'true' || val === '1';
};

exports.setBoolAttribute = function (xml, attr, value) {
    if (value) {
        xml.setAttribute(attr, '1');
    } else {
        xml.removeAttribute(attr);
    }
};

exports.getSubAttribute = function (xml, NS, sub, attr, defaultVal) {
    var subs = find(xml, NS, sub);
    if (!subs) {
        return '';
    }

    for (var i = 0; i < subs.length; i++) {
        return subs[i].getAttribute(attr) || defaultVal || '';
    }

    return '';
};

exports.setSubAttribute = function (xml, NS, sub, attr, value) {
    var subs = find(xml, NS, sub);
    if (!subs.length) {
        if (value) {
            sub = exports.createElement(NS, sub, xml.namespaceURI);
            sub.setAttribute(attr, value);
            xml.appendChild(sub);
        }
    } else {
        for (var i = 0; i < subs.length; i++) {
            if (value) {
                subs[i].setAttribute(attr, value);
                return;
            } else {
                subs[i].removeAttribute(attr);
            }
        }
    }
};

exports.getBoolSubAttribute = function (xml, NS, sub, attr, defaultVal) {
    var val = xml.getSubAttribute(NS, sub, attr) || defaultVal || '';
    return val === 'true' || val === '1';
};

exports.setBoolSubAttribute = function (xml, NS, sub, attr, value) {
    value = value ? '1' : '';
    exports.setSubAttribute(xml, NS, sub, attr, value);
};

exports.getText = function (xml) {
    return xml.textContent;
};

exports.setText = function (xml, value) {
    xml.textContent = value;
};

exports.getSubText = function (xml, NS, element, defaultVal) {
    var subs = find(xml, NS, element);

    defaultVal = defaultVal || '';

    if (!subs.length) {
        return defaultVal;
    }

    return subs[0].textContent || defaultVal;
};

exports.setSubText = function (xml, NS, element, value) {
    var subs = find(xml, NS, element);
    if (subs.length) {
        for (var i = 0; i < subs.length; i++) {
            xml.removeChild(subs[i]);
        }
    }

    if (value) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        if (value !== true) {
            sub.textContent = value;
        }
        xml.appendChild(sub);
    }
};

exports.getMultiSubText = function (xml, NS, element, extractor) {
    var subs = find(xml, NS, element);
    var results = [];

    extractor = extractor || function (sub) {
        return sub.textContent || '';
    };

    for (var i = 0; i < subs.length; i++) {
        results.push(extractor(subs[i]));
    }

    return results;
};

exports.setMultiSubText = function (xml, NS, element, value, builder) {
    var subs = find(xml, NS, element);
    var values = [];
    builder = builder || function (value) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        sub.textContent = value;
        xml.appendChild(sub);
    };
    if (typeof value === 'string') {
        values = (value || '').split('\n');
    } else {
        values = value;
    }
    _.forEach(subs, function (sub) {
        xml.removeChild(sub);
    });
    _.forEach(values, function (val) {
        if (val) {
            builder(val);
        }
    });
};

exports.getMultiSubAttribute = function (xml, NS, element, attr) {
    return exports.getMultiSubText(xml, NS, element, function (sub) {
        return exports.getAttribute(sub, attr);
    });
};

exports.setMultiSubAttribute = function (xml, NS, element, attr, value) {
    exports.setMultiSubText(xml, NS, element, value, function (val) {
        var sub = exports.createElement(NS, element, xml.namespaceURI);
        exports.setAttribute(sub, attr, val);
        xml.appendChild(sub);
    });
};

exports.getSubLangText = function (xml, NS, element, defaultLang) {
    var subs = find(xml, NS, element);
    if (!subs.length) {
        return {};
    }

    var lang, sub;
    var results = {};
    var langs = [];

    for (var i = 0; i < subs.length; i++) {
        sub = subs[i];
        lang = sub.getAttributeNS(XML_NS, 'lang') || defaultLang;
        langs.push(lang);
        results[lang] = sub.textContent || '';
    }

    return results;
};

exports.setSubLangText = function (xml, NS, element, value, defaultLang) {
    var sub, lang;
    var subs = find(xml, NS, element);
    if (subs.length) {
        for (var i = 0; i < subs.length; i++) {
            xml.removeChild(subs[i]);
        }
    }

    if (typeof value === 'string') {
        sub = exports.createElement(NS, element, xml.namespaceURI);
        sub.textContent = value;
        xml.appendChild(sub);
    } else if (typeof value === 'object') {
        for (lang in value) {
            if (value.hasOwnProperty(lang)) {
                sub = exports.createElement(NS, element, xml.namespaceURI);
                if (lang !== defaultLang) {
                    sub.setAttributeNS(XML_NS, 'lang', lang);
                }
                sub.textContent = value[lang];
                xml.appendChild(sub);
            }
        }
    }
};

exports.getBoolSub = function (xml, NS, element) {
    var subs = find(xml, NS, element);
    return !!subs.length;
};

exports.setBoolSub = function (xml, NS, element, value) {
    var subs = find(xml, NS, element);
    if (!subs.length) {
        if (value) {
            var sub = exports.createElement(NS, element, xml.namespaceURI);
            xml.appendChild(sub);
        }
    } else {
        for (var i = 0; i < subs.length; i++) {
            if (value) {
                return;
            } else {
                xml.removeChild(subs[i]);
            }
        }
    }
};

},{"ltx-dom-shim":208,"underscore":222}],207:[function(_dereq_,module,exports){
'use strict';

var _ = _dereq_('underscore');
var fromB64 = _dereq_('atob');
var toB64 = _dereq_('btoa');

var helpers = _dereq_('./helpers');
var find = helpers.find;


var field = exports.field = function (getter, setter) {
    return function () {
        var args = _.toArray(arguments);
        return {
            get: function () {
                return getter.apply(null, [this.xml].concat(args));
            },
            set: function (value) {
                setter.apply(null, ([this.xml].concat(args)).concat([value]));
            }
        };
    };
};

exports.field = field;
exports.boolAttribute = field(helpers.getBoolAttribute,
                              helpers.setBoolAttribute);
exports.subAttribute = field(helpers.getSubAttribute,
                             helpers.setSubAttribute);
exports.boolSubAttribute = field(helpers.getSubBoolAttribute,
                                 helpers.setSubBoolAttribute);
exports.text = field(helpers.getText,
                     helpers.setText);
exports.subText = field(helpers.getSubText,
                        helpers.setSubText);
exports.multiSubText = field(helpers.getMultiSubText,
                             helpers.setMultiSubText);
exports.multiSubAttribute  = field(helpers.getMultiSubAttribute,
                                   helpers.setMultiSubAttribute);
exports.subLangText = field(helpers.getSubLangText,
                            helpers.setSubLangText);
exports.boolSub = field(helpers.getBoolSub,
                        helpers.setBoolSub);

exports.langAttribute = field(
    function (xml) {
        return xml.getAttributeNS(helpers.XML_NS, 'lang') || '';
    },
    function (xml, value) {
        xml.setAttributeNS(helpers.XML_NS, 'lang', value);
    }
);

exports.b64Text = field(
    function (xml) {
        if (xml.textContent && xml.textContent !== '=') {
            return fromB64(xml.textContent);
        }
        return '';
    },
    function (xml, value) {
        xml.textContent = toB64(value) || '=';
    }
);

exports.dateAttribute = function (attr, now) {
    return {
        get: function () {
            var data = helpers.getAttribute(this.xml, attr);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setAttribute(this.xml, attr, value);
        }
    };
};

exports.dateSub = function (NS, sub, now) {
    return {
        get: function () {
            var data = helpers.getSubText(this.xml, NS, sub);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setSubText(this.xml, NS, sub, value);
        }
    };
};

exports.dateSubAttribute = function (NS, sub, attr, now) {
    return {
        get: function () {
            var data = helpers.getSubAttribute(this.xml, NS, sub, attr);
            if (data) {
                return new Date(data);
            }
            if (now) {
                return new Date(Date.now());
            }
        },
        set: function (value) {
            if (!value) {
                return;
            }
            if (typeof value !== 'string') {
                value = value.toISOString();
            }
            helpers.setSubAttribute(this.xml, NS, sub, attr, value);
        }
    };
};

exports.numberAttribute = function (attr, isFloat, defaultVal) {
    return {
        get: function () {
            var parse = isFloat ? parseFloat : parseInt;
            var data = helpers.getAttribute(this.xml, attr, '');
            if (!data) {
                return defaultVal;
            }
            var parsed = parse(data, 10);
            if (isNaN(parsed)) {
                return defaultVal;
            }

            return parsed;
        },
        set: function (value) {
            helpers.setAttribute(this.xml, attr, value.toString());
        }
    };
};

exports.numberSub = function (NS, sub, isFloat, defaultVal) {
    return {
        get: function () {
            var parse = isFloat ? parseFloat : parseInt;
            var data = helpers.getSubText(this.xml, NS, sub, '');
            if (!data) {
                return defaultVal;
            }

            var parsed = parse(data, 10);
            if (isNaN(parsed)) {
                return defaultVal;
            }

            return parsed;
        },
        set: function (value) {
            helpers.setSubText(this.xml, NS, sub, value.toString());
        }
    };
};

exports.attribute = function (name, defaultVal) {
    return {
        get: function () {
            return helpers.getAttribute(this.xml, name, defaultVal);
        },
        set: function (value) {
            helpers.setAttribute(this.xml, name, value);
        }
    };
};

exports.attributeNS = function (NS, name, defaultVal) {
    return {
        get: function () {
            return helpers.getAttributeNS(this.xml, NS, name, defaultVal);
        },
        set: function (value) {
            helpers.setAttributeNS(this.xml, NS, name, value);
        }
    };
};

exports.extension = function (ChildJXT) {
    return {
        get: function () {
            var self = this;
            var name = ChildJXT.prototype._name;
            if (!this._extensions[name]) {
                var existing = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
                if (!existing.length) {
                    this._extensions[name] = new ChildJXT({}, null, self);
                    this.xml.appendChild(this._extensions[name].xml);
                } else {
                    this._extensions[name] = new ChildJXT(null, existing[0], self);
                }
                this._extensions[name].parent = this;
            }
            return this._extensions[name];
        },
        set: function (value) {
            if (value) {
                var child = this[ChildJXT.prototype._name];
                if (value === true) {
                    value = {};
                }
                _.extend(child, value);
            }
        }
    };
};

exports.multiExtension = function (ChildJXT) {
    return {
        get: function () {
            var self = this;
            var data = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);
            var results = [];

            _.forEach(data, function (xml) {
                results.push(new ChildJXT({}, xml, self));
            });
            return results;
        },
        set: function (value) {
            var self = this;
            var existing = find(this.xml, ChildJXT.prototype._NS, ChildJXT.prototype._EL);

            _.forEach(existing, function (item) {
                self.xml.removeChild(item);
            });

            _.forEach(value, function (data) {
                var content = new ChildJXT(data, null, self);
                self.xml.appendChild(content.xml);
            });
        }
    };
};

},{"./helpers":206,"atob":107,"btoa":170,"underscore":222}],208:[function(_dereq_,module,exports){
var parser = new window.DOMParser();
var serializer = new window.XMLSerializer();

module.exports = {
    serializeToString: function (obj) {
        return serializer.serializeToString(obj);
    },
    parseFromString: function (str, mimetype) {
        return parser.parseFromString(str, mimetype);
    },
    createElementNS: function (ns, name) {
        return document.createElementNS(ns, name);
    }
};

},{}],209:[function(_dereq_,module,exports){
(function (Buffer){
//     uuid.js
//
//     Copyright (c) 2010-2012 Robert Kieffer
//     MIT License - http://opensource.org/licenses/mit-license.php

(function() {
  var _global = this;

  // Unique ID creation requires a high quality random # generator.  We feature
  // detect to determine the best RNG source, normalizing to a function that
  // returns 128-bits of randomness, since that's what's usually required
  var _rng;

  // Node.js crypto-based RNG - http://nodejs.org/docs/v0.6.2/api/crypto.html
  //
  // Moderately fast, high quality
  if (typeof(_dereq_) == 'function') {
    try {
      var _rb = _dereq_('crypto').randomBytes;
      _rng = _rb && function() {return _rb(16);};
    } catch(e) {}
  }

  if (!_rng && _global.crypto && crypto.getRandomValues) {
    // WHATWG crypto-based RNG - http://wiki.whatwg.org/wiki/Crypto
    //
    // Moderately fast, high quality
    var _rnds8 = new Uint8Array(16);
    _rng = function whatwgRNG() {
      crypto.getRandomValues(_rnds8);
      return _rnds8;
    };
  }

  if (!_rng) {
    // Math.random()-based (RNG)
    //
    // If all else fails, use Math.random().  It's fast, but is of unspecified
    // quality.
    var  _rnds = new Array(16);
    _rng = function() {
      for (var i = 0, r; i < 16; i++) {
        if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
        _rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
      }

      return _rnds;
    };
  }

  // Buffer class to use
  var BufferClass = typeof(Buffer) == 'function' ? Buffer : Array;

  // Maps for number <-> hex string conversion
  var _byteToHex = [];
  var _hexToByte = {};
  for (var i = 0; i < 256; i++) {
    _byteToHex[i] = (i + 0x100).toString(16).substr(1);
    _hexToByte[_byteToHex[i]] = i;
  }

  // **`parse()` - Parse a UUID into it's component bytes**
  function parse(s, buf, offset) {
    var i = (buf && offset) || 0, ii = 0;

    buf = buf || [];
    s.toLowerCase().replace(/[0-9a-f]{2}/g, function(oct) {
      if (ii < 16) { // Don't overflow!
        buf[i + ii++] = _hexToByte[oct];
      }
    });

    // Zero out remaining bytes if string was short
    while (ii < 16) {
      buf[i + ii++] = 0;
    }

    return buf;
  }

  // **`unparse()` - Convert UUID byte array (ala parse()) into a string**
  function unparse(buf, offset) {
    var i = offset || 0, bth = _byteToHex;
    return  bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] + '-' +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]] +
            bth[buf[i++]] + bth[buf[i++]];
  }

  // **`v1()` - Generate time-based UUID**
  //
  // Inspired by https://github.com/LiosK/UUID.js
  // and http://docs.python.org/library/uuid.html

  // random #'s we need to init node and clockseq
  var _seedBytes = _rng();

  // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
  var _nodeId = [
    _seedBytes[0] | 0x01,
    _seedBytes[1], _seedBytes[2], _seedBytes[3], _seedBytes[4], _seedBytes[5]
  ];

  // Per 4.2.2, randomize (14 bit) clockseq
  var _clockseq = (_seedBytes[6] << 8 | _seedBytes[7]) & 0x3fff;

  // Previous uuid creation time
  var _lastMSecs = 0, _lastNSecs = 0;

  // See https://github.com/broofa/node-uuid for API details
  function v1(options, buf, offset) {
    var i = buf && offset || 0;
    var b = buf || [];

    options = options || {};

    var clockseq = options.clockseq != null ? options.clockseq : _clockseq;

    // UUID timestamps are 100 nano-second units since the Gregorian epoch,
    // (1582-10-15 00:00).  JSNumbers aren't precise enough for this, so
    // time is handled internally as 'msecs' (integer milliseconds) and 'nsecs'
    // (100-nanoseconds offset from msecs) since unix epoch, 1970-01-01 00:00.
    var msecs = options.msecs != null ? options.msecs : new Date().getTime();

    // Per 4.2.1.2, use count of uuid's generated during the current clock
    // cycle to simulate higher resolution clock
    var nsecs = options.nsecs != null ? options.nsecs : _lastNSecs + 1;

    // Time since last uuid creation (in msecs)
    var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs)/10000;

    // Per 4.2.1.2, Bump clockseq on clock regression
    if (dt < 0 && options.clockseq == null) {
      clockseq = clockseq + 1 & 0x3fff;
    }

    // Reset nsecs if clock regresses (new clockseq) or we've moved onto a new
    // time interval
    if ((dt < 0 || msecs > _lastMSecs) && options.nsecs == null) {
      nsecs = 0;
    }

    // Per 4.2.1.2 Throw error if too many uuids are requested
    if (nsecs >= 10000) {
      throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
    }

    _lastMSecs = msecs;
    _lastNSecs = nsecs;
    _clockseq = clockseq;

    // Per 4.1.4 - Convert from unix epoch to Gregorian epoch
    msecs += 12219292800000;

    // `time_low`
    var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
    b[i++] = tl >>> 24 & 0xff;
    b[i++] = tl >>> 16 & 0xff;
    b[i++] = tl >>> 8 & 0xff;
    b[i++] = tl & 0xff;

    // `time_mid`
    var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
    b[i++] = tmh >>> 8 & 0xff;
    b[i++] = tmh & 0xff;

    // `time_high_and_version`
    b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
    b[i++] = tmh >>> 16 & 0xff;

    // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
    b[i++] = clockseq >>> 8 | 0x80;

    // `clock_seq_low`
    b[i++] = clockseq & 0xff;

    // `node`
    var node = options.node || _nodeId;
    for (var n = 0; n < 6; n++) {
      b[i + n] = node[n];
    }

    return buf ? buf : unparse(b);
  }

  // **`v4()` - Generate random UUID**

  // See https://github.com/broofa/node-uuid for API details
  function v4(options, buf, offset) {
    // Deprecated - 'format' argument, as supported in v1.2
    var i = buf && offset || 0;

    if (typeof(options) == 'string') {
      buf = options == 'binary' ? new BufferClass(16) : null;
      options = null;
    }
    options = options || {};

    var rnds = options.random || (options.rng || _rng)();

    // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;

    // Copy bytes to buffer, if provided
    if (buf) {
      for (var ii = 0; ii < 16; ii++) {
        buf[i + ii] = rnds[ii];
      }
    }

    return buf || unparse(rnds);
  }

  // Export public API
  var uuid = v4;
  uuid.v1 = v1;
  uuid.v4 = v4;
  uuid.parse = parse;
  uuid.unparse = unparse;
  uuid.BufferClass = BufferClass;

  if (typeof define === 'function' && define.amd) {
    // Publish as AMD module
    define(function() {return uuid;});
  } else if (typeof(module) != 'undefined' && module.exports) {
    // Publish as node.js module
    module.exports = uuid;
  } else {
    // Publish as global (in browsers)
    var _previousRoot = _global.uuid;

    // **`noConflict()` - (browser only) to reset global 'uuid' var**
    uuid.noConflict = function() {
      _global.uuid = _previousRoot;
      return uuid;
    };

    _global.uuid = uuid;
  }
}).call(this);

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148,"crypto":154}],210:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * ANONYMOUS `Mechanism` constructor.
   *
   * This class implements the ANONYMOUS SASL mechanism.
   *
   * The ANONYMOUS SASL mechanism provides support for permitting anonymous
   * access to various services
   *
   * References:
   *  - [RFC 4505](http://tools.ietf.org/html/rfc4505)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'ANONYMOUS';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using optional trace information.
   *
   * Options:
   *  - `trace`  trace information (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    return cred.trace || '';
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
  };

  exports = module.exports = Mechanism;
  
}));

},{}],211:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports,
            module,
            _dereq_('./lib/mechanism'));
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports',
            'module',
            './lib/mechanism'], factory);
  }
}(this, function(exports, module, Mechanism) {

  exports = module.exports = Mechanism;
  exports.Mechanism = Mechanism;
  
}));

},{"./lib/mechanism":210}],212:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * EXTERNAL `Mechanism` constructor.
   *
   * This class implements the EXTERNAL SASL mechanism.
   *
   * The EXTERNAL SASL mechanism provides support for authentication using
   * credentials established by external means. 
   *
   * References:
   *  - [RFC 4422](http://tools.ietf.org/html/rfc4422)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'EXTERNAL';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using given credential.
   *
   * Options:
   *  - `authzid`   authorization identity (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    return cred.authzid || '';
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
  };

  exports = module.exports = Mechanism;
  
}));

},{}],213:[function(_dereq_,module,exports){
arguments[4][211][0].apply(exports,arguments)
},{"./lib/mechanism":212}],214:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {

  /**
   * PLAIN `Mechanism` constructor.
   *
   * This class implements the PLAIN SASL mechanism.
   *
   * The PLAIN SASL mechanism provides support for exchanging a clear-text
   * username and password.  This mechanism should not be used without adequate
   * security provided by an underlying transport layer. 
   *
   * References:
   *  - [RFC 4616](http://tools.ietf.org/html/rfc4616)
   *
   * @api public
   */
  function Mechanism() {
  }
  
  Mechanism.prototype.name = 'PLAIN';
  Mechanism.prototype.clientFirst = true;
  
  /**
   * Encode a response using given credential.
   *
   * Options:
   *  - `username`
   *  - `password`
   *  - `authzid`   authorization identity (optional)
   *
   * @param {Object} cred
   * @api public
   */
  Mechanism.prototype.response = function(cred) {
    var str = '';
    str += cred.authzid || '';
    str += '\0';
    str += cred.username;
    str += '\0';
    str += cred.password;
    return str;
  };
  
  /**
   * Decode a challenge issued by the server.
   *
   * @param {String} chal
   * @return {Mechanism} for chaining
   * @api public
   */
  Mechanism.prototype.challenge = function(chal) {
    return this;
  };

  exports = module.exports = Mechanism;
  
}));

},{}],215:[function(_dereq_,module,exports){
arguments[4][211][0].apply(exports,arguments)
},{"./lib/mechanism":214}],216:[function(_dereq_,module,exports){
(function (Buffer){
var bitops = _dereq_('./lib/bitops');
var utils = _dereq_('./lib/utils');

var RESP = {};


function Mechanism(options) {
    options = options || {};
    this._genNonce = options.genNonce || utils.genNonce;
    this._stage = 'initial';
}

// Conform to the SASL lib's expectations
Mechanism.Mechanism = Mechanism;


Mechanism.prototype.name = 'SCRAM-SHA-1';
Mechanism.prototype.clientFirst = true;


Mechanism.prototype.response = function (cred) {
    return RESP[this._stage](this, cred);
};

Mechanism.prototype.challenge = function (chal) {
    var values = utils.parse(chal);

    this._salt = new Buffer(values.s || '', 'base64').toString('binary');
    this._iterationCount = parseInt(values.i, 10);
    this._nonce = values.r;
    this._verifier = values.v;
    this._error = values.e;
    this._challenge = chal;

    return this;
};


RESP.initial = function (mech, cred) {
    mech._cnonce = mech._genNonce();

    var authzid = '';
    if (cred.authzid) {
        authzid = 'a=' + utils.saslname(cred.authzid);
    }

    mech._gs2Header = 'n,' + authzid + ',';

    var nonce = 'r=' + mech._cnonce;
    var username = 'n=' + utils.saslname(cred.username);

    mech._clientFirstMessageBare = username + ',' + nonce;
    var result = mech._gs2Header + mech._clientFirstMessageBare;

    mech._stage = 'challenge';

    return result;
};


RESP.challenge = function (mech, cred) {
    var gs2Header = new Buffer(mech._gs2Header).toString('base64');

    mech._clientFinalMessageWithoutProof = 'c=' + gs2Header + ',r=' + mech._nonce;

    var saltedPassword, clientKey, serverKey;
    if (cred.clientKey && cred.serverKey) {
        clientKey = cred.clientKey;
        serverKey = cred.serverKey;
    } else {
        saltedPassword = cred.saltedPassword || bitops.Hi(cred.password, mech._salt, mech._iterationCount);
        clientKey = bitops.HMAC(saltedPassword, 'Client Key');
        serverKey = bitops.HMAC(saltedPassword, 'Server Key');
    }

    var storedKey = bitops.H(clientKey);
    var authMessage = mech._clientFirstMessageBare + ',' +
                      mech._challenge + ',' +
                      mech._clientFinalMessageWithoutProof;
    var clientSignature = bitops.HMAC(storedKey, authMessage);

    var xorstuff = bitops.XOR(clientKey, clientSignature);

    var clientProof = new Buffer(xorstuff, 'binary').toString('base64');

    mech._serverSignature = bitops.HMAC(serverKey, authMessage);

    var result = mech._clientFinalMessageWithoutProof + ',p=' + clientProof;

    mech._stage = 'final';

    mech.cache = {
        saltedPassword: saltedPassword,
        clientKey: clientKey,
        serverKey: serverKey
    };

    return result;
};

RESP.final = function () {
    // TODO: Signal errors
    return '';
};



module.exports = Mechanism;

}).call(this,_dereq_("buffer").Buffer)
},{"./lib/bitops":217,"./lib/utils":218,"buffer":148}],217:[function(_dereq_,module,exports){
(function (Buffer){
var crypto = _dereq_('crypto');
var xor = _dereq_('bitwise-xor');


exports.XOR = xor;

exports.H = function (text) {
    return crypto.createHash('sha1').update(text).digest();
};

exports.HMAC = function (key, msg) {
    return crypto.createHmac('sha1', key).update(msg).digest();
};

exports.Hi = function (text, salt, iterations) {
    var ui1 = exports.HMAC(text, salt + new Buffer([0, 0, 0, 1]).toString('binary'));
    var ui = ui1;
    for (var i = 0; i < iterations - 1; i++) {
        ui1 = exports.HMAC(text, ui1);
        ui = exports.XOR(ui, ui1);
    }

    return ui;
};


}).call(this,_dereq_("buffer").Buffer)
},{"bitwise-xor":219,"buffer":148,"crypto":154}],218:[function(_dereq_,module,exports){
var crypto = _dereq_('crypto');


exports.parse = function (chal) {
    var dtives = {};
    var tokens = chal.split(/,(?=(?:[^"]|"[^"]*")*$)/);
    for (var i = 0, len = tokens.length; i < len; i++) {
        var dtiv = /(\w+)=["]?([^"]+)["]?$/.exec(tokens[i]);
        if (dtiv) {
            dtives[dtiv[1]] = dtiv[2];
        }
    }
    return dtives;
};

exports.saslname = function (name) {
    var escaped = [];
    var curr = '';
    for (var i = 0; i < name.length; i++) {
        curr = name[i];
        if (curr === ',') {
            escaped.push('=2C');
        } else if (curr === '=') {
            escaped.push('=3D');
        } else {
            escaped.push(curr);
        }
    }
    return escaped.join('');
};

exports.genNonce = function (len) {
    return crypto.randomBytes((len || 32) / 2).toString('hex');
};

},{"crypto":154}],219:[function(_dereq_,module,exports){
(function (Buffer){
module.exports = xor

function xor(a, b) {
  if (!Buffer.isBuffer(a)) a = new Buffer(a)
  if (!Buffer.isBuffer(b)) b = new Buffer(b)
  var res = []
  if (a.length > b.length) {
    for (var i = 0; i < b.length; i++) {
      res.push(a[i] ^ b[i])
    }
  } else {
    for (var i = 0; i < a.length; i++) {
      res.push(a[i] ^ b[i])
    }
  }
  return new Buffer(res);
}

}).call(this,_dereq_("buffer").Buffer)
},{"buffer":148}],220:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports, module);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports', 'module'], factory);
  }
}(this, function(exports, module) {
  
  /**
   * `Factory` constructor.
   *
   * @api public
   */
  function Factory() {
    this._mechs = [];
  }
  
  /**
   * Utilize the given `mech` with optional `name`, overridding the mechanism's
   * default name.
   *
   * Examples:
   *
   *     factory.use(FooMechanism);
   *
   *     factory.use('XFOO', FooMechanism);
   *
   * @param {String|Mechanism} name
   * @param {Mechanism} mech
   * @return {Factory} for chaining
   * @api public
   */
  Factory.prototype.use = function(name, mech) {
    if (!mech) {
      mech = name;
      name = mech.prototype.name;
    }
    this._mechs.push({ name: name, mech: mech });
    return this;
  };
  
  /**
   * Create a new mechanism from supported list of `mechs`.
   *
   * If no mechanisms are supported, returns `null`.
   *
   * Examples:
   *
   *     var mech = factory.create(['FOO', 'BAR']);
   *
   * @param {Array} mechs
   * @return {Mechanism}
   * @api public
   */
  Factory.prototype.create = function(mechs) {
    for (var i = 0, len = this._mechs.length; i < len; i++) {
      for (var j = 0, jlen = mechs.length; j < jlen; j++) {
        var entry = this._mechs[i];
        if (entry.name == mechs[j]) {
          return new entry.mech();
        }
      }
    }
    return null;
  };

  exports = module.exports = Factory;
  
}));

},{}],221:[function(_dereq_,module,exports){
(function(root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    factory(exports,
            module,
            _dereq_('./lib/factory'));
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['exports',
            'module',
            './lib/factory'], factory);
  }
}(this, function(exports, module, Factory) {
  
  exports = module.exports = Factory;
  exports.Factory = Factory;
  
}));

},{"./lib/factory":220}],222:[function(_dereq_,module,exports){
//     Underscore.js 1.6.0
//     http://underscorejs.org
//     (c) 2009-2014 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
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
  _.VERSION = '1.6.0';

  // Collection Functions
  // --------------------

  // The cornerstone, an `each` implementation, aka `forEach`.
  // Handles objects with the built-in `forEach`, arrays, and raw objects.
  // Delegates to **ECMAScript 5**'s native `forEach` if available.
  var each = _.each = _.forEach = function(obj, iterator, context) {
    if (obj == null) return obj;
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
    return obj;
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
  _.find = _.detect = function(obj, predicate, context) {
    var result;
    any(obj, function(value, index, list) {
      if (predicate.call(context, value, index, list)) {
        result = value;
        return true;
      }
    });
    return result;
  };

  // Return all the elements that pass a truth test.
  // Delegates to **ECMAScript 5**'s native `filter` if available.
  // Aliased as `select`.
  _.filter = _.select = function(obj, predicate, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeFilter && obj.filter === nativeFilter) return obj.filter(predicate, context);
    each(obj, function(value, index, list) {
      if (predicate.call(context, value, index, list)) results.push(value);
    });
    return results;
  };

  // Return all the elements for which a truth test fails.
  _.reject = function(obj, predicate, context) {
    return _.filter(obj, function(value, index, list) {
      return !predicate.call(context, value, index, list);
    }, context);
  };

  // Determine whether all of the elements match a truth test.
  // Delegates to **ECMAScript 5**'s native `every` if available.
  // Aliased as `all`.
  _.every = _.all = function(obj, predicate, context) {
    predicate || (predicate = _.identity);
    var result = true;
    if (obj == null) return result;
    if (nativeEvery && obj.every === nativeEvery) return obj.every(predicate, context);
    each(obj, function(value, index, list) {
      if (!(result = result && predicate.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if at least one element in the object matches a truth test.
  // Delegates to **ECMAScript 5**'s native `some` if available.
  // Aliased as `any`.
  var any = _.some = _.any = function(obj, predicate, context) {
    predicate || (predicate = _.identity);
    var result = false;
    if (obj == null) return result;
    if (nativeSome && obj.some === nativeSome) return obj.some(predicate, context);
    each(obj, function(value, index, list) {
      if (result || (result = predicate.call(context, value, index, list))) return breaker;
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
    return _.map(obj, _.property(key));
  };

  // Convenience version of a common use case of `filter`: selecting only objects
  // containing specific `key:value` pairs.
  _.where = function(obj, attrs) {
    return _.filter(obj, _.matches(attrs));
  };

  // Convenience version of a common use case of `find`: getting the first object
  // containing specific `key:value` pairs.
  _.findWhere = function(obj, attrs) {
    return _.find(obj, _.matches(attrs));
  };

  // Return the maximum element or (element-based computation).
  // Can't optimize arrays of integers longer than 65,535 elements.
  // See [WebKit Bug 80797](https://bugs.webkit.org/show_bug.cgi?id=80797)
  _.max = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.max.apply(Math, obj);
    }
    var result = -Infinity, lastComputed = -Infinity;
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      if (computed > lastComputed) {
        result = value;
        lastComputed = computed;
      }
    });
    return result;
  };

  // Return the minimum element (or element-based computation).
  _.min = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.min.apply(Math, obj);
    }
    var result = Infinity, lastComputed = Infinity;
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      if (computed < lastComputed) {
        result = value;
        lastComputed = computed;
      }
    });
    return result;
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

  // Sample **n** random values from a collection.
  // If **n** is not specified, returns a single random element.
  // The internal `guard` argument allows it to work with `map`.
  _.sample = function(obj, n, guard) {
    if (n == null || guard) {
      if (obj.length !== +obj.length) obj = _.values(obj);
      return obj[_.random(obj.length - 1)];
    }
    return _.shuffle(obj).slice(0, Math.max(0, n));
  };

  // An internal function to generate lookup iterators.
  var lookupIterator = function(value) {
    if (value == null) return _.identity;
    if (_.isFunction(value)) return value;
    return _.property(value);
  };

  // Sort the object's values by a criterion produced by an iterator.
  _.sortBy = function(obj, iterator, context) {
    iterator = lookupIterator(iterator);
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
    return function(obj, iterator, context) {
      var result = {};
      iterator = lookupIterator(iterator);
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
    _.has(result, key) ? result[key].push(value) : result[key] = [value];
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
    iterator = lookupIterator(iterator);
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
    if ((n == null) || guard) return array[0];
    if (n < 0) return [];
    return slice.call(array, 0, n);
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
    if ((n == null) || guard) return array[array.length - 1];
    return slice.call(array, Math.max(array.length - n, 0));
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

  // Split an array into two arrays: one whose elements all satisfy the given
  // predicate, and one whose elements all do not satisfy the predicate.
  _.partition = function(array, predicate) {
    var pass = [], fail = [];
    each(array, function(elem) {
      (predicate(elem) ? pass : fail).push(elem);
    });
    return [pass, fail];
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
        return _.contains(other, item);
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
    var length = _.max(_.pluck(arguments, 'length').concat(0));
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
  // arguments pre-filled, without changing its dynamic `this` context. _ acts
  // as a placeholder, allowing any combination of arguments to be pre-filled.
  _.partial = function(func) {
    var boundArgs = slice.call(arguments, 1);
    return function() {
      var position = 0;
      var args = boundArgs.slice();
      for (var i = 0, length = args.length; i < length; i++) {
        if (args[i] === _) args[i] = arguments[position++];
      }
      while (position < arguments.length) args.push(arguments[position++]);
      return func.apply(this, args);
    };
  };

  // Bind a number of an object's methods to that object. Remaining arguments
  // are the method names to be bound. Useful for ensuring that all callbacks
  // defined on an object belong to it.
  _.bindAll = function(obj) {
    var funcs = slice.call(arguments, 1);
    if (funcs.length === 0) throw new Error('bindAll must be passed function names');
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
      previous = options.leading === false ? 0 : _.now();
      timeout = null;
      result = func.apply(context, args);
      context = args = null;
    };
    return function() {
      var now = _.now();
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
        result = func.apply(context, args);
        context = args = null;
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

    var later = function() {
      var last = _.now() - timestamp;
      if (last < wait) {
        timeout = setTimeout(later, wait - last);
      } else {
        timeout = null;
        if (!immediate) {
          result = func.apply(context, args);
          context = args = null;
        }
      }
    };

    return function() {
      context = this;
      args = arguments;
      timestamp = _.now();
      var callNow = immediate && !timeout;
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      if (callNow) {
        result = func.apply(context, args);
        context = args = null;
      }

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
    return _.partial(wrapper, func);
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
  _.keys = function(obj) {
    if (!_.isObject(obj)) return [];
    if (nativeKeys) return nativeKeys(obj);
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
                             _.isFunction(bCtor) && (bCtor instanceof bCtor))
                        && ('constructor' in a && 'constructor' in b)) {
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

  _.constant = function(value) {
    return function () {
      return value;
    };
  };

  _.property = function(key) {
    return function(obj) {
      return obj[key];
    };
  };

  // Returns a predicate for checking whether an object has a given set of `key:value` pairs.
  _.matches = function(attrs) {
    return function(obj) {
      if (obj === attrs) return true; //avoid comparing an object to itself.
      for (var key in attrs) {
        if (attrs[key] !== obj[key])
          return false;
      }
      return true;
    }
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

  // A (possibly faster) way to get the current timestamp as an integer.
  _.now = Date.now || function() { return new Date().getTime(); };

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

  // AMD registration happens at the end for compatibility with AMD loaders
  // that may not enforce next-turn semantics on modules. Even though general
  // practice for AMD registration is to be anonymous, underscore registers
  // as a named module because, like jQuery, it is a base library that is
  // popular enough to be bundled in a third party lib, but not be part of
  // an AMD load request. Those cases could generate an error when an
  // anonymous define() is called outside of a loader request.
  if (typeof define === 'function' && define.amd) {
    define('underscore', [], function() {
      return _;
    });
  }
}).call(this);

},{}],223:[function(_dereq_,module,exports){
(function (global){
/*! http://mths.be/utf8js v2.0.0 by @mathias */
;(function(root) {

	// Detect free variables `exports`
	var freeExports = typeof exports == 'object' && exports;

	// Detect free variable `module`
	var freeModule = typeof module == 'object' && module &&
		module.exports == freeExports && module;

	// Detect free variable `global`, from Node.js or Browserified code,
	// and use it as `root`
	var freeGlobal = typeof global == 'object' && global;
	if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal) {
		root = freeGlobal;
	}

	/*--------------------------------------------------------------------------*/

	var stringFromCharCode = String.fromCharCode;

	// Taken from http://mths.be/punycode
	function ucs2decode(string) {
		var output = [];
		var counter = 0;
		var length = string.length;
		var value;
		var extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	// Taken from http://mths.be/punycode
	function ucs2encode(array) {
		var length = array.length;
		var index = -1;
		var value;
		var output = '';
		while (++index < length) {
			value = array[index];
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
		}
		return output;
	}

	/*--------------------------------------------------------------------------*/

	function createByte(codePoint, shift) {
		return stringFromCharCode(((codePoint >> shift) & 0x3F) | 0x80);
	}

	function encodeCodePoint(codePoint) {
		if ((codePoint & 0xFFFFFF80) == 0) { // 1-byte sequence
			return stringFromCharCode(codePoint);
		}
		var symbol = '';
		if ((codePoint & 0xFFFFF800) == 0) { // 2-byte sequence
			symbol = stringFromCharCode(((codePoint >> 6) & 0x1F) | 0xC0);
		}
		else if ((codePoint & 0xFFFF0000) == 0) { // 3-byte sequence
			symbol = stringFromCharCode(((codePoint >> 12) & 0x0F) | 0xE0);
			symbol += createByte(codePoint, 6);
		}
		else if ((codePoint & 0xFFE00000) == 0) { // 4-byte sequence
			symbol = stringFromCharCode(((codePoint >> 18) & 0x07) | 0xF0);
			symbol += createByte(codePoint, 12);
			symbol += createByte(codePoint, 6);
		}
		symbol += stringFromCharCode((codePoint & 0x3F) | 0x80);
		return symbol;
	}

	function utf8encode(string) {
		var codePoints = ucs2decode(string);

		// console.log(JSON.stringify(codePoints.map(function(x) {
		// 	return 'U+' + x.toString(16).toUpperCase();
		// })));

		var length = codePoints.length;
		var index = -1;
		var codePoint;
		var byteString = '';
		while (++index < length) {
			codePoint = codePoints[index];
			byteString += encodeCodePoint(codePoint);
		}
		return byteString;
	}

	/*--------------------------------------------------------------------------*/

	function readContinuationByte() {
		if (byteIndex >= byteCount) {
			throw Error('Invalid byte index');
		}

		var continuationByte = byteArray[byteIndex] & 0xFF;
		byteIndex++;

		if ((continuationByte & 0xC0) == 0x80) {
			return continuationByte & 0x3F;
		}

		// If we end up here, it’s not a continuation byte
		throw Error('Invalid continuation byte');
	}

	function decodeSymbol() {
		var byte1;
		var byte2;
		var byte3;
		var byte4;
		var codePoint;

		if (byteIndex > byteCount) {
			throw Error('Invalid byte index');
		}

		if (byteIndex == byteCount) {
			return false;
		}

		// Read first byte
		byte1 = byteArray[byteIndex] & 0xFF;
		byteIndex++;

		// 1-byte sequence (no continuation bytes)
		if ((byte1 & 0x80) == 0) {
			return byte1;
		}

		// 2-byte sequence
		if ((byte1 & 0xE0) == 0xC0) {
			var byte2 = readContinuationByte();
			codePoint = ((byte1 & 0x1F) << 6) | byte2;
			if (codePoint >= 0x80) {
				return codePoint;
			} else {
				throw Error('Invalid continuation byte');
			}
		}

		// 3-byte sequence (may include unpaired surrogates)
		if ((byte1 & 0xF0) == 0xE0) {
			byte2 = readContinuationByte();
			byte3 = readContinuationByte();
			codePoint = ((byte1 & 0x0F) << 12) | (byte2 << 6) | byte3;
			if (codePoint >= 0x0800) {
				return codePoint;
			} else {
				throw Error('Invalid continuation byte');
			}
		}

		// 4-byte sequence
		if ((byte1 & 0xF8) == 0xF0) {
			byte2 = readContinuationByte();
			byte3 = readContinuationByte();
			byte4 = readContinuationByte();
			codePoint = ((byte1 & 0x0F) << 0x12) | (byte2 << 0x0C) |
				(byte3 << 0x06) | byte4;
			if (codePoint >= 0x010000 && codePoint <= 0x10FFFF) {
				return codePoint;
			}
		}

		throw Error('Invalid UTF-8 detected');
	}

	var byteArray;
	var byteCount;
	var byteIndex;
	function utf8decode(byteString) {
		byteArray = ucs2decode(byteString);
		byteCount = byteArray.length;
		byteIndex = 0;
		var codePoints = [];
		var tmp;
		while ((tmp = decodeSymbol()) !== false) {
			codePoints.push(tmp);
		}
		return ucs2encode(codePoints);
	}

	/*--------------------------------------------------------------------------*/

	var utf8 = {
		'version': '2.0.0',
		'encode': utf8encode,
		'decode': utf8decode
	};

	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define(function() {
			return utf8;
		});
	}	else if (freeExports && !freeExports.nodeType) {
		if (freeModule) { // in Node.js or RingoJS v0.8.0+
			freeModule.exports = utf8;
		} else { // in Narwhal or RingoJS v0.7.0-
			var object = {};
			var hasOwnProperty = object.hasOwnProperty;
			for (var key in utf8) {
				hasOwnProperty.call(utf8, key) && (freeExports[key] = utf8[key]);
			}
		}
	} else { // in Rhino or a web browser
		root.utf8 = utf8;
	}

}(this));

}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],224:[function(_dereq_,module,exports){
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

/// Emit `event` with the given args.
// also calls any `*` handlers
WildEmitter.prototype.emit = function (event) {
    var args = [].slice.call(arguments, 1),
        callbacks = this.callbacks[event],
        specialCallbacks = this.getWildcardCallbacks(event),
        i,
        len,
        item,
        listeners;

    if (callbacks) {
        listeners = callbacks.slice();
        for (i = 0, len = listeners.length; i < len; ++i) {
            if (listeners[i]) {
                listeners[i].apply(this, args);
            } else {
                break;
            }
        }
    }

    if (specialCallbacks) {
        len = specialCallbacks.length;
        listeners = specialCallbacks.slice();
        for (i = 0, len = listeners.length; i < len; ++i) {
            if (listeners[i]) {
                listeners[i].apply(this, [event].concat(args));
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
        if (item === '*' || (split.length === 2 && eventName.slice(0, split[0].length) === split[0])) {
            result = result.concat(this.callbacks[item]);
        }
    }
    return result;
};

},{}],225:[function(_dereq_,module,exports){
'use strict';

var StringPrep = _dereq_('./lib/stringprep');


function bareJID(local, domain) {
    if (local) {
        return local + '@' + domain;
    }
    return domain;
}

function fullJID(local, domain, resource) {
    if (resource) {
        return bareJID(local, domain) + '/' + resource;
    }
    return bareJID(local, domain);
}


exports.prep = function (data) {
    var local = data.local;
    var domain = data.domain;
    var resource = data.resource;
    var unescapedLocal = local;

    if (local) {
        local = StringPrep.nodeprep(local);
        unescapedLocal = exports.unescape(local);
    }

    if (resource) {
        resource = StringPrep.resourceprep(resource);
    }

    if (domain[domain.length - 1] === '.') {
        domain = domain.slice(0, domain.length - 1);
    }

    domain = StringPrep.nameprep(domain.split('.').map(StringPrep.toUnicode).join('.'));

    return {
        prepped: data.prepped || StringPrep.available,
        local: local,
        domain: domain,
        resource: resource,
        bare: bareJID(local, domain),
        full: fullJID(local, domain, resource),
        unescapedLocal: unescapedLocal,
        unescapedBare: bareJID(unescapedLocal, domain),
        unescapedFull: fullJID(unescapedLocal, domain, resource)
    };
};

exports.parse = function (jid, trusted) {
    var local = '';
    var domain = '';
    var resource = '';

    // All of our StringPrep fallbacks work correctly
    // in the ASCII range, so we can reliably mark
    // ASCII-only JIDs as prepped.
    trusted = /^[\x00-\x7F]*$/.test(jid);

    var resourceStart = jid.indexOf('/');
    if (resourceStart > 0) {
        resource = jid.slice(resourceStart + 1);
        jid = jid.slice(0, resourceStart);
    }

    var localEnd = jid.indexOf('@');
    if (localEnd > 0) {
        local = jid.slice(0, localEnd);
        jid = jid.slice(localEnd + 1);
    }

    domain = jid;

    var preppedJID = exports.prep({
        local: local,
        domain: domain,
        resource: resource,
    });

    preppedJID.prepped = preppedJID.prepped || trusted;

    return preppedJID;
};

exports.equal = function (jid1, jid2, requirePrep) {
    jid1 = new exports.JID(jid1);
    jid2 = new exports.JID(jid2);
    if (arguments.length === 2) {
        requirePrep = true;
    }
    return jid1.local === jid2.local &&
           jid1.domain === jid2.domain &&
           jid1.resource === jid2.resource &&
           (requirePrep ? jid1.prepped && jid2.prepped : true);
};

exports.equalBare = function (jid1, jid2, requirePrep) {
    jid1 = new exports.JID(jid1);
    jid2 = new exports.JID(jid2);
    if (arguments.length === 2) {
        requirePrep = true;
    }
    return jid1.local === jid2.local &&
           jid1.domain === jid2.domain &&
           (requirePrep ? jid1.prepped && jid2.prepped : true);
};

exports.escape = function (val) {
    return val.replace(/^\s+|\s+$/g, '')
              .replace(/\\5c/g, '\\5c5c')
              .replace(/\\20/g, '\\5c20')
              .replace(/\\22/g, '\\5c22')
              .replace(/\\26/g, '\\5c26')
              .replace(/\\27/g, '\\5c27')
              .replace(/\\2f/g, '\\5c2f')
              .replace(/\\3a/g, '\\5c3a')
              .replace(/\\3c/g, '\\5c3c')
              .replace(/\\3e/g, '\\5c3e')
              .replace(/\\40/g, '\\5c40')
              .replace(/ /g, '\\20')
              .replace(/\"/g, '\\22')
              .replace(/\&/g, '\\26')
              .replace(/\'/g, '\\27')
              .replace(/\//g, '\\2f')
              .replace(/:/g, '\\3a')
              .replace(/</g, '\\3c')
              .replace(/>/g, '\\3e')
              .replace(/@/g, '\\40');
};

exports.unescape = function (val) {
    return val.replace(/\\20/g, ' ')
              .replace(/\\22/g, '"')
              .replace(/\\26/g, '&')
              .replace(/\\27/g, '\'')
              .replace(/\\2f/g, '/')
              .replace(/\\3a/g, ':')
              .replace(/\\3c/g, '<')
              .replace(/\\3e/g, '>')
              .replace(/\\40/g, '@')
              .replace(/\\5c/g, '\\');
};


exports.create = function (local, domain, resource) {
    return new exports.JID(local, domain, resource);
};

exports.JID = function JID(localOrJID, domain, resource) {
    var parsed = {};
    if (localOrJID && !domain && !resource) {
        if (typeof localOrJID === 'string') {
            parsed = exports.parse(localOrJID);
        } else if (localOrJID instanceof exports.JID) {
            parsed = localOrJID;
        } else {
            throw new Error('Invalid argument type');
        }
    } else if (domain) {
        parsed = exports.prep({
            local: exports.escape(localOrJID),
            domain: domain,
            resource: resource
        });
    } else {
        parsed = {};
    }

    this.local = parsed.local || '';
    this.domain = parsed.domain || '';
    this.resource = parsed.resource || '';
    this.bare = parsed.bare || '';
    this.full = parsed.full || '';

    this.unescapedLocal = parsed.unescapedLocal || '';
    this.unescapedBare = parsed.unescapedBare || '';
    this.unescapedFull = parsed.unescapedFull || '';

    this.prepped = parsed.prepped;
};

exports.JID.prototype.toString = function () {
    return this.full;
};

exports.JID.prototype.toJSON = function () {
    return this.full;
};

},{"./lib/stringprep":226}],226:[function(_dereq_,module,exports){
'use strict';

var StringPrep = _dereq_('node-stringprep');
var punycode = _dereq_('punycode');


// We still might not be able to use proper StringPrep,
// so we create a test instance and check if the native
// option is available.
exports.available = new StringPrep.StringPrep('nodeprep').isNative();

exports.toUnicode = function (data) {
    return punycode.toUnicode(StringPrep.toUnicode(data));
};

exports.nameprep = function (str) {
    var prep = new StringPrep.StringPrep('nameprep');
    return prep.prepare(str);
};

exports.nodeprep = function (str) {
    var prep = new StringPrep.StringPrep('nodeprep');
    return prep.prepare(str);
};

exports.resourceprep = function (str) {
    var prep = new StringPrep.StringPrep('resourceprep');
    return prep.prepare(str);
};

},{"node-stringprep":227,"punycode":167}],227:[function(_dereq_,module,exports){
'use strict';

// from unicode/uidna.h
var UIDNA_ALLOW_UNASSIGNED = 1
var UIDNA_USE_STD3_RULES = 2

try {
    var bindings = _dereq_('bindings')('node_stringprep.node')
} catch (ex) {
    console.warn(
        'Cannot load StringPrep-' +
        _dereq_('./package.json').version +
        ' bindings (using fallback). You may need to ' +
        '`npm install node-stringprep`'
    )
}

var toUnicode = function(value, options) {
    options = options || {}
    try {
        return bindings.toUnicode(value,
            (options.allowUnassigned && UIDNA_ALLOW_UNASSIGNED) | 0)
    } catch (e) {
        return value
    }
}

var toASCII = function(value, options) {
    options = options || {}
    try {
        return bindings.toASCII(value,
            (options.allowUnassigned && UIDNA_ALLOW_UNASSIGNED) |
            (options.useSTD3Rules && UIDNA_USE_STD3_RULES))
    } catch (e) {
        if (options.throwIfError)
            throw e
        else
            return value
    }
}

var StringPrep = function(operation) {
    this.operation = operation
    try {
        this.stringPrep = new bindings.StringPrep(this.operation)
    } catch (e) {
        this.stringPrep = null
    }
}

StringPrep.prototype.UNKNOWN_PROFILE_TYPE = 'Unknown profile type'
StringPrep.prototype.UNHANDLED_FALLBACK = 'Unhandled JS fallback'
StringPrep.prototype.LIBICU_NOT_AVAILABLE = 'libicu unavailable'

StringPrep.prototype.useJsFallbacks = true

StringPrep.prototype.prepare = function(value) {
    this.value = value
    try {
        if (this.stringPrep) {
            return this.stringPrep.prepare(this.value)
        }
    } catch (e) {}
    if (false === this.useJsFallbacks)
        throw new Error(this.LIBICU_NOT_AVAILABLE)
    return this.jsFallback()
}

StringPrep.prototype.isNative = function() {
    return (null !== this.stringPrep)
}

StringPrep.prototype.jsFallback = function() {
    switch (this.operation) {
        case 'nameprep':
        case 'nodeprep':
            return this.value.toLowerCase()
        case 'resourceprep':
            return this.value
        case 'nfs4_cs_prep':
        case 'nfs4_cis_prep':
        case 'nfs4_mixed_prep prefix':
        case 'nfs4_mixed_prep suffix':
        case 'iscsi':
        case 'mib':
        case 'saslprep':
        case 'trace':
        case 'ldap':
        case 'ldapci':
            throw new Error(this.UNHANDLED_FALLBACK)
        default:
            throw new Error(this.UNKNOWN_PROFILE_TYPE)
    }
}

StringPrep.prototype.disableJsFallbacks = function() {
    this.useJsFallbacks = false
}

StringPrep.prototype.enableJsFallbacks = function() {
    this.useJsFallbacks = true
}

module.exports = {
    toUnicode: toUnicode,
    toASCII: toASCII,
    StringPrep: StringPrep
}

},{"./package.json":229,"bindings":228}],228:[function(_dereq_,module,exports){
(function (process,__filename){

/**
 * Module dependencies.
 */

var fs = _dereq_('fs')
  , path = _dereq_('path')
  , join = path.join
  , dirname = path.dirname
  , exists = fs.existsSync || path.existsSync
  , defaults = {
        arrow: process.env.NODE_BINDINGS_ARROW || ' → '
      , compiled: process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled'
      , platform: process.platform
      , arch: process.arch
      , version: process.versions.node
      , bindings: 'bindings.node'
      , try: [
          // node-gyp's linked version in the "build" dir
          [ 'module_root', 'build', 'bindings' ]
          // node-waf and gyp_addon (a.k.a node-gyp)
        , [ 'module_root', 'build', 'Debug', 'bindings' ]
        , [ 'module_root', 'build', 'Release', 'bindings' ]
          // Debug files, for development (legacy behavior, remove for node v0.9)
        , [ 'module_root', 'out', 'Debug', 'bindings' ]
        , [ 'module_root', 'Debug', 'bindings' ]
          // Release files, but manually compiled (legacy behavior, remove for node v0.9)
        , [ 'module_root', 'out', 'Release', 'bindings' ]
        , [ 'module_root', 'Release', 'bindings' ]
          // Legacy from node-waf, node <= 0.4.x
        , [ 'module_root', 'build', 'default', 'bindings' ]
          // Production "Release" buildtype binary (meh...)
        , [ 'module_root', 'compiled', 'version', 'platform', 'arch', 'bindings' ]
        ]
    }

/**
 * The main `bindings()` function loads the compiled bindings for a given module.
 * It uses V8's Error API to determine the parent filename that this function is
 * being invoked from, which is then used to find the root directory.
 */

function bindings (opts) {

  // Argument surgery
  if (typeof opts == 'string') {
    opts = { bindings: opts }
  } else if (!opts) {
    opts = {}
  }
  opts.__proto__ = defaults

  // Get the module root
  if (!opts.module_root) {
    opts.module_root = exports.getRoot(exports.getFileName())
  }

  // Ensure the given bindings name ends with .node
  if (path.extname(opts.bindings) != '.node') {
    opts.bindings += '.node'
  }

  var tries = []
    , i = 0
    , l = opts.try.length
    , n
    , b
    , err

  for (; i<l; i++) {
    n = join.apply(null, opts.try[i].map(function (p) {
      return opts[p] || p
    }))
    tries.push(n)
    try {
      b = opts.path ? _dereq_.resolve(n) : _dereq_(n)
      if (!opts.path) {
        b.path = n
      }
      return b
    } catch (e) {
      if (!/not find/i.test(e.message)) {
        throw e
      }
    }
  }

  err = new Error('Could not locate the bindings file. Tried:\n'
    + tries.map(function (a) { return opts.arrow + a }).join('\n'))
  err.tries = tries
  throw err
}
module.exports = exports = bindings


/**
 * Gets the filename of the JavaScript file that invokes this function.
 * Used to help find the root directory of a module.
 */

exports.getFileName = function getFileName () {
  var origPST = Error.prepareStackTrace
    , origSTL = Error.stackTraceLimit
    , dummy = {}
    , fileName

  Error.stackTraceLimit = 10

  Error.prepareStackTrace = function (e, st) {
    for (var i=0, l=st.length; i<l; i++) {
      fileName = st[i].getFileName()
      if (fileName !== __filename) {
        return
      }
    }
  }

  // run the 'prepareStackTrace' function above
  Error.captureStackTrace(dummy)
  dummy.stack

  // cleanup
  Error.prepareStackTrace = origPST
  Error.stackTraceLimit = origSTL

  return fileName
}

/**
 * Gets the root directory of a module, given an arbitrary filename
 * somewhere in the module tree. The "root directory" is the directory
 * containing the `package.json` file.
 *
 *   In:  /home/nate/node-native-module/lib/index.js
 *   Out: /home/nate/node-native-module
 */

exports.getRoot = function getRoot (file) {
  var dir = dirname(file)
    , prev
  while (true) {
    if (dir === '.') {
      // Avoids an infinite loop in rare cases, like the REPL
      dir = process.cwd()
    }
    if (exists(join(dir, 'package.json')) || exists(join(dir, 'node_modules'))) {
      // Found the 'package.json' file or 'node_modules' dir; we're done
      return dir
    }
    if (prev === dir) {
      // Got to the top
      throw new Error('Could not find module root given file: "' + file
                    + '". Do you have a `package.json` file? ')
    }
    // Try the parent dir next
    prev = dir
    dir = join(dir, '..')
  }
}

}).call(this,_dereq_("FWaASH"),"/node_modules/xmpp-jid/node_modules/node-stringprep/node_modules/bindings/bindings.js")
},{"FWaASH":166,"fs":146,"path":165}],229:[function(_dereq_,module,exports){
module.exports={
  "name": "node-stringprep",
  "version": "0.5.2",
  "main": "index.js",
  "description": "ICU StringPrep profiles",
  "keywords": [
    "unicode",
    "stringprep",
    "icu"
  ],
  "scripts": {
    "test": "grunt test",
    "install": "node-gyp rebuild"
  },
  "dependencies": {
    "nan": "^1.2.0",
    "bindings": "~1.1.1"
  },
  "devDependencies": {
    "proxyquire": "~0.5.2",
    "grunt-mocha-cli": "~1.3.0",
    "grunt-contrib-jshint": "~0.7.2",
    "should": "~2.1.1",
    "grunt": "~0.4.2"
  },
  "repository": {
    "type": "git",
    "path": "git://github.com/node-xmpp/node-stringprep.git"
  },
  "homepage": "http://github.com/node-xmpp/node-stringprep",
  "bugs": {
    "url": "http://github.com/node-xmpp/node-stringprep/issues"
  },
  "author": {
    "name": "Lloyd Watkin",
    "email": "lloyd@evilprofessor.co.uk",
    "url": "http://evilprofessor.co.uk"
  },
  "licenses": [
    {
      "type": "MIT"
    }
  ],
  "engines": {
    "node": ">=0.8"
  },
  "gypfile": true,
  "_id": "node-stringprep@0.5.2",
  "dist": {
    "shasum": "51d9fee119ae06cec3e0876fc93e33ee97ca3054",
    "tarball": "http://registry.npmjs.org/node-stringprep/-/node-stringprep-0.5.2.tgz"
  },
  "_from": "node-stringprep@^0.5.2",
  "_npmVersion": "1.4.3",
  "_npmUser": {
    "name": "lloydwatkin",
    "email": "lloyd@evilprofessor.co.uk"
  },
  "maintainers": [
    {
      "name": "astro",
      "email": "astro@spaceboyz.net"
    },
    {
      "name": "lloydwatkin",
      "email": "lloyd@evilprofessor.co.uk"
    }
  ],
  "directories": {},
  "_shasum": "51d9fee119ae06cec3e0876fc93e33ee97ca3054",
  "_resolved": "https://registry.npmjs.org/node-stringprep/-/node-stringprep-0.5.2.tgz"
}

},{}]},{},[1])
(1)
});