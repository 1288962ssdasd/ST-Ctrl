// ICU polyfill for Node.js compiled without ICU.
// 1. Monkey-patch TextDecoder to strip the "fatal" option.
const OrigTextDecoder = globalThis.TextDecoder;
if (OrigTextDecoder) {
    globalThis.TextDecoder = function (encoding, options) {
        if (options && options.fatal !== undefined) {
            options = Object.assign({}, options, { fatal: false });
        }
        return new OrigTextDecoder(encoding, options);
    };
    Object.setPrototypeOf(globalThis.TextDecoder, OrigTextDecoder);
    globalThis.TextDecoder.prototype = OrigTextDecoder.prototype;
}

// 2. Monkey-patch RegExp constructor to strip \p{...} Unicode property escapes
//    and the /u flag when the engine doesn't support them.
const OrigRegExp = globalThis.RegExp;
try {
    // Test if A-Za-z\u00C0-\u024F is supported
    new OrigRegExp('\A-Za-z\u00C0-\u024F', 'u');
} catch (e) {
    // Not supported — patch RegExp to strip \p{...} and /u flag
    globalThis.RegExp = function (pattern, flags) {
        if (typeof pattern === 'string') {
            // Remove \p{...} escape sequences and replace with broad class
            pattern = pattern.replace(/\\p\{[A-Za-z_]+\}/g, '\\w');
            // Remove /u flag since we stripped Unicode properties
            if (typeof flags === 'string') {
                flags = flags.replace(/u/g, '');
            }
        }
        return new OrigRegExp(pattern, flags);
    };
    Object.setPrototypeOf(globalThis.RegExp, OrigRegExp);
    globalThis.RegExp.prototype = OrigRegExp.prototype;
}
