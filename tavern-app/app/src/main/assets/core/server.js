// Wrapper to polyfill Node.js compiled without ICU support.

// 0. Stub Intl API (missing when Node.js is compiled without ICU)
if (!globalThis.Intl) {
    globalThis.Intl = {
        DateTimeFormat: function(locale, options) {
            return {
                format: function(date) { return String(date); },
                formatRange: function(a, b) { return String(a) + ' - ' + String(b); },
                resolvedOptions: function() { return { locale: locale || 'en', timeZone: 'UTC' }; },
            };
        },
        NumberFormat: function(locale, options) {
            return {
                format: function(n) { return String(n); },
                resolvedOptions: function() { return { locale: locale || 'en' }; },
            };
        },
        Collator: function(locale, options) {
            return { compare: function(a, b) { return String(a).localeCompare(String(b)); } };
        },
        PluralRules: function(locale, options) {
            return { select: function(n) { return 'other'; } };
        },
        RelativeTimeFormat: function(locale, options) {
            return { format: function(n, unit) { return String(n) + ' ' + unit; } };
        },
        ListFormat: function(locale, options) {
            return { format: function(list) { return list.join(', '); } };
        },
        DisplayNames: function(locale, options) {
            return { of: function(code) { return code; } };
        },
        getCanonicalLocales: function(locales) { return Array.isArray(locales) ? locales : [locales]; },
        supportedValuesOf: function() { return []; },
    };
}

// 1. Monkey-patch TextDecoder to strip the unsupported "fatal" option.
const OrigTextDecoder = globalThis.TextDecoder;
globalThis.TextDecoder = function (encoding, options) {
    if (options && options.fatal !== undefined) {
        options = Object.assign({}, options, { fatal: false });
    }
    return new OrigTextDecoder(encoding, options);
};
Object.setPrototypeOf(globalThis.TextDecoder, OrigTextDecoder);
globalThis.TextDecoder.prototype = OrigTextDecoder.prototype;

// 2. Monkey-patch RegExp constructor to strip Unicode property escapes
//    (handles dynamic regex creation via new RegExp(pattern, flags))
const OrigRegExp = globalThis.RegExp;
try {
    // Quick test: does this engine support \p{...}?
    new OrigRegExp('\\p{L}', 'u');
} catch (_noIcu) {
    globalThis.RegExp = function (pattern, flags) {
        if (typeof pattern === 'string') {
            // Remove \p{XXX} Unicode property escapes
            pattern = pattern.replace(/\\p\{[A-Za-z_]+\}/g, '');
            // Remove /u flag since Unicode properties were stripped
            if (typeof flags === 'string') {
                flags = flags.replace(/u/g, '');
            }
        }
        return new OrigRegExp(pattern, flags);
    };
    Object.setPrototypeOf(globalThis.RegExp, OrigRegExp);
    globalThis.RegExp.prototype = OrigRegExp.prototype;
}

// 3. Monkey-patch child_process to prevent ENOENT crashes on Android
//    (xdg-open, open, etc. don't exist)
import child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
const origSpawn = child_process.spawn;
const origExec = child_process.exec;
const origExecFile = child_process.execFile;

function makeDummy() {
    const d = new EventEmitter();
    d.stdin = { end() {}, on() {} };
    d.stdout = { on() {}, pipe() {} };
    d.stderr = { on() {} };
    setImmediate(() => d.emit('close', 1));
    return d;
}

function safeSpawn(cmd, args, options) {
    try {
        const child = origSpawn(cmd, args, options);
        child.on('error', () => {}); // Swallow ENOENT errors
        return child;
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.warn('Non-fatal spawn error (ignored):', e.message);
            return makeDummy();
        }
        throw e;
    }
}
child_process.spawn = safeSpawn;
child_process.exec = function(cmd, ...rest) {
    if (typeof cmd === 'string' && (cmd.includes('xdg-open') || cmd.includes('open'))) {
        console.warn('Skipping exec:', cmd.split(' ')[0]);
        const cb = rest[rest.length - 1];
        if (typeof cb === 'function') setImmediate(() => cb(new Error('Not supported on Android'), '', ''));
        return makeDummy();
    }
    return origExec.call(this, cmd, ...rest);
};
child_process.execFile = function(file, ...rest) {
    if (typeof file === 'string' && (file.includes('xdg-open') || file === 'open')) {
        console.warn('Skipping execFile:', file);
        const cb = rest[rest.length - 1];
        if (typeof cb === 'function') setImmediate(() => cb(new Error('Not supported on Android'), '', ''));
        return makeDummy();
    }
    return origExecFile.call(this, file, ...rest);
};

// Also global safety net for uncaught exceptions
process.on('uncaughtException', (err) => {
    if (err && err.code === 'ENOENT') {
        console.warn('Non-fatal error (ignored):', err.message);
        return;
    }
    console.error('Uncaught exception:', err);
});

// Now load the real server
import('./server-real.js');
