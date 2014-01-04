require.config({
    baseUrl: 'js',
    paths: {
        'libs/jquery': 'https://ajax.googleapis.com/ajax/libs/jquery/2.0.3/jquery.min',
        'jslix': 'https://raw.github.com/jbinary/jslix/master/src/',
        //'jslix': 'http://dev.habahaba.im/js/libs/jslix',
        'libs': 'libs',
        'cryptojs': 'http://crypto-js.googlecode.com/svn/tags/3.1.2/src/',
        'contextmenu': 'libs/jQuery-contextmenu'
    },
    shim: {
        'libs/jquery': {
            exports: '$'
        },
        'contextmenu/jquery.contextMenu': ['libs/jquery'],
        'contextmenu/jquery.ui.position': ['contextmenu/jquery.contextMenu'],
        'libs/jquery.transit': ['libs/jquery'],
        'cryptojs/core': {
            exports: 'CryptoJS'
        },
        'cryptojs/md5': {
            deps: ['cryptojs/core'],
            exports: 'CryptoJS.MD5'
        },
        'cryptojs/sha1': {
            deps: ['cryptojs/core'],
            exports: 'CryptoJS.SHA1'
        },
        'cryptojs/enc-base64': {
            deps: ['cryptojs/core'],
            exports: 'CryptoJS.enc.Base64'
        }
    }
});
