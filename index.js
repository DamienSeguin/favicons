const _ = require('underscore'),
    async = require('async'),
    through2 = require('through2'),
    clone = require('clone'),
    mergeDefaults = require('merge-defaults'),
    configDefaults = require('require-directory')(module, 'config'),
    helpers = require('./helpers-es5.js'),
    path = require('path'),
    toIco = require('to-ico');

(() => {

    'use strict';

    _.mergeDefaults = mergeDefaults;

    function favicons (source, parameters, next) {

        const config = clone(configDefaults),
            options = _.mergeDefaults(parameters || {}, config.defaults),
            µ = helpers(options),
            background = µ.General.background(options.background);

        function createFavicon (sourceset, properties, name, platformOptions, callback) {
            if (path.extname(name) === '.ico') {
                async.map(
                    properties.sizes,
                    (sizeProperties, cb) => {
                        const newProperties = clone(properties);

                        newProperties.width = sizeProperties.width;
                        newProperties.height = sizeProperties.height;

                        const tempName = `favicon-temp-${newProperties.width}x${newProperties.height}.png`;

                        createFavicon(sourceset, newProperties, tempName, platformOptions, cb);
                    },
                    (error, results) => {
                        const files = [];

                        results.forEach((icoImage) => {
                            files.push(icoImage.contents);
                        });

                        toIco(files).then((buffer) => {
                            callback(error, { name, contents: buffer });
                        });
                    }
                );
            } else {
                const maximum = Math.max(properties.width, properties.height),
                    offset = Math.round(maximum / 100 * platformOptions.offset) || 0;

                async.waterfall([
                    (cb) =>
                        µ.Images.nearest(sourceset, properties, cb),
                    (nearest, cb) =>
                        µ.Images.read(nearest.file, cb),
                    (buffer, cb) =>
                        µ.Images.resize(buffer, properties, offset, cb),
                    (resizedBuffer, cb) =>
                        µ.Images.create(properties, background, (error, canvas) =>
                            cb(error, resizedBuffer, canvas)),
                    (resizedBuffer, canvas, cb) =>
                        µ.Images.composite(canvas, resizedBuffer, properties, maximum - offset, cb),
                    (composite, cb) => {
                        µ.Images.getBuffer(composite, cb);
                    }
                ], (error, buffer) =>
                    callback(error, { name, contents: buffer }));
            }

        }

        function createHTML (platform, callback) {
            const html = [];

            async.forEachOf(config.html[platform], (tag, selector, cb) =>
                µ.HTML.parse(tag, (error, metadata) =>
                    cb(html.push(metadata) && error)),
            (error) =>
                callback(error, html));
        }

        function createFiles (platform, callback) {
            const files = [];

            async.forEachOf(config.files[platform], (properties, name, cb) =>
                µ.Files.create(properties, name, (error, file) =>
                    cb(files.push(file) && error)),
            (error) =>
                callback(error, files));
        }

        function createFavicons (sourceset, platform, platformOptions, callback) {
            const images = [];

            async.forEachOf(config.icons[platform], (properties, name, cb) =>
                createFavicon(sourceset, properties, name, platformOptions, (error, image) =>
                    cb(images.push(image) && error)),
            (error) =>
                callback(error, images));
        }

        function createPlatform (sourceset, platform, platformOptions, callback) {
            async.parallel([
                (cb) =>
                    createFavicons(sourceset, platform, platformOptions, cb),
                (cb) =>
                    createFiles(platform, cb),
                (cb) =>
                    createHTML(platform, cb)
            ], (error, results) =>
                callback(error, results[0], results[1], results[2]));
        }

        function createOffline (sourceset, callback) {
            const response = { images: [], files: [], html: [] };

            async.forEachOf(options.icons, (enabled, platform, cb) => {
                const platformOptions = typeof enabled == "object" ? enabled : {};

                if (enabled) {
                    createPlatform(sourceset, platform, platformOptions, (error, images, files, html) => {
                        response.images = response.images.concat(images);
                        response.files = response.files.concat(files);
                        response.html = response.html.concat(html);
                        cb(error);
                    });
                } else {
                    return cb(null);
                }
            }, (error) =>
                callback(error, response));
        }

        function unpack (pack, callback) {
            const response = { images: [], files: [], html: pack.html.split(',') };

            async.each(pack.files, (url, cb) =>
                µ.RFG.fetch(url, (error, box) =>
                    cb(response.images.push(box.image) && response.files.push(box.file) && error)),
            (error) =>
                callback(error, response));
        }

        function createOnline (sourceset, callback) {
            async.waterfall([
                (cb) =>
                    µ.RFG.configure(sourceset, config.rfg, cb),
                (request, cb) =>
                    µ.RFG.request(request, cb),
                (pack, cb) =>
                    unpack(pack, cb)
            ], (error, results) =>
                callback(error, results));
        }

        function create (sourceset, callback) {
            options.online ? createOnline(sourceset, callback) : createOffline(sourceset, callback);
        }

        async.waterfall([
            (callback) =>
                µ.General.source(source, callback),
            (sourceset, callback) =>
                create(sourceset, callback),
            (response, callback) => {
                if (options.pipeHTML) {
                    µ.Files.create(response.html, options.html, (error, file) => {
                        response.files = response.files.concat([file]);
                        return callback(error, response);
                    });
                } else {
                    return callback(null, response);
                }
            }
        ], (error, response) =>
            error ? next(error) : next(null, {
                images: _.compact(response.images),
                files: _.compact(response.files),
                html: _.compact(response.html)
            }));
    }

    function stream (params, handleHtml) {

        const config = clone(configDefaults),
            µ = helpers(params);

        function processDocuments (documents, html, callback) {
            async.each(documents, (document, cb) =>
                µ.HTML.update(document, html, config.html, cb),
            (error) =>
                callback(error));
        }

        /* eslint func-names: 0, no-invalid-this: 0 */
        return through2.obj(function (file, encoding, callback) {
            const that = this;

            if (file.isNull()) {
                return callback(null, file);
            }

            if (file.isStream()) {
                return callback(new Error('[gulp-favicons] Streaming not supported'));
            }

            async.waterfall([
                (cb) =>
                    favicons(file.contents, params, cb),
                (response, cb) =>
                    async.each(response.images.concat(response.files), (image, c) => {
                        that.push(µ.General.vinyl(image));
                        c();
                    }, (error) =>
                        cb(error, response)),
                (response, cb) => {
                    if (handleHtml) {
                        handleHtml(response.html);
                        return cb(null);
                    }
                    if (params.html && !params.pipeHTML) {
                        const documents = typeof params.html === 'object' ? params.html : [params.html];

                        processDocuments(documents, response.html, cb);
                    } else {
                        return cb(null);
                    }
                }
            ], (error) =>
                callback(error));
        });
    }

    module.exports = favicons;
    module.exports.config = configDefaults;
    module.exports.stream = stream;

})();
