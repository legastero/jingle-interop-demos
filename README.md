# Jingle Interop Demos

A collection of JavaScript Jingle clients for interop and testing purposes.

Includes demo clients from the following projects:
- [stanza.io](https://github.com/legastero/stanza.io)
- [strophe.jingle](https://github.com/ESTOS/strophe.jingle)
- [JSJaCJingle.js](https://github.com/valeriansaliou/jsjac-jingle)
- [xmpp-ftw](https://xmpp-ftw.jit.su/)

## Aim

The aim of this repository is to introduce you to interoperable webRTC projects using XMPP Jingle as the signalling mechanism.

## Running

Place any of these projects behind a webserver and load via a browser to use.

Two examples of quickly running the demos without a full webserver are as follows:

### Python

`python -m SimpleHTTPServer`

Will start a webserver on port 8000 (default).

### Nodejs 

If you don't already have [grunt](http://gruntjs.com/) CLI tools installed perform as follows:

```
npm i -g grunt-cli
```

Then install the dependencies and run the server:

```js
npm i .
grunt connect
```

Will start a webserver on port 3333 (default).
