/*
  node-http-proxy.js: http proxy for node.js

  Copyright (c) 2010 Charlie Robbins, Mikeal Rogers, Marak Squires, Fedor Indutny

  Permission is hereby granted, free of charge, to any person obtaining
  a copy of this software and associated documentation files (the
  "Software"), to deal in the Software without restriction, including
  without limitation the rights to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, and to
  permit persons to whom the Software is furnished to do so, subject to
  the following conditions:

  The above copyright notice and this permission notice shall be
  included in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
  NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
  LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
  WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

var events = require('events'),
    http = require('http'),
    util = require('util'),
    httpProxy = require('../node-http-proxy');

//
// ### function HttpProxy (options)
// #### @options {Object} Options for this instance.
// Constructor function for new instances of HttpProxy responsible
// for managing the life-cycle of streaming reverse proxyied HTTP requests.
//
// Example options:
//
//      {
//        target: {
//          host: 'localhost',
//          port: 9000
//        },
//        forward: {
//          host: 'localhost',
//          port: 9001
//        }
//      }
//
var HttpProxy = exports.HttpProxy = function (options) {
  if (!options || !options.target) {
    throw new Error('Both `options` and `options.target` are required.');
  }
    
  events.EventEmitter.call(this);
  
  var self  = this;

  //
  // Setup basic proxying options: 
  // 
  // * forward {Object} Options for a forward-proxy (if-any)
  // * target {Object} Options for the **sole** proxy target of this instance
  //
  this.forward  = options.forward;
  this.target   = options.target;

  //
  // Setup the necessary instances instance variables for
  // the `target` and `forward` `host:port` combinations
  // used by this instance. 
  //
  // * agent {http[s].Agent} Agent to be used by this instance.
  // * protocol {http|https} Core node.js module to make requests with.
  // * base {Object} Base object to create when proxying containing any https settings.
  //  
  function setupProxy (key) {
    self[key].agent    = httpProxy._getAgent(self[key]);
    self[key].protocol = httpProxy._getProtocol(self[key]);
    self[key].base     = httpProxy._getBase(self[key]); 
  }
  
  setupProxy('target');
  if (this.forward) { 
    setupProxy('forward'); 
  }
  
  //
  // Setup opt-in features
  //
  this.enable          = options.enable || {};
  this.enable.xforward = typeof this.enable.xforward === 'boolean'
    ? this.enable.xforward
    : true;

  //
  // Setup additional options for WebSocket proxying. When forcing
  // the WebSocket handshake to change the `sec-websocket-location`
  // and `sec-websocket-origin` headers `options.source` **MUST**
  // be provided or the operation will fail with an `origin mismatch`
  // by definition.
  //
  this.source       = options.source       || { host: 'localhost', port: 8000 };
  this.source.https = this.source.https    || options.https;
  this.changeOrigin = options.changeOrigin || false;  
};

// Inherit from events.EventEmitter
util.inherits(HttpProxy, events.EventEmitter);

//
// ### function proxyRequest (req, res, [port, host, paused])
// #### @req {ServerRequest} Incoming HTTP Request to proxy.
// #### @res {ServerResponse} Outgoing HTTP Request to write proxied data to.
// #### @buffer {Object} Result from `httpProxy.buffer(req)`
//
HttpProxy.prototype.proxyRequest = function (req, res, buffer) {
  var self = this, 
      errState = false,
      outgoing = new(this.target.base),
      reverseProxy;

  //
  // Add common proxy headers to the request so that they can
  // be availible to the proxy target server. If the proxy is 
  // part of proxy chain it will append the address:
  //
  // * `x-forwarded-for`: IP Address of the original request
  // * `x-forwarded-proto`: Protocol of the original request
  // * `x-forwarded-port`: Port of the original request.
  //
  if (this.enable.xforward && req.connection && req.socket) {

    if (req.headers['x-forwarded-for']){
        var addressToAppend = "," + req.connection.remoteAddress || req.socket.remoteAddress;
        req.headers['x-forwarded-for']   += addressToAppend;
    } else {
        req.headers['x-forwarded-for']   = req.connection.remoteAddress || req.socket.remoteAddress;
    }

    if (req.headers['x-forwarded-port']){
        var portToAppend = "," + req.connection.remotePort || req.socket.remotePort;
        req.headers['x-forwarded-port']   += portToAppend;
    } else {
        req.headers['x-forwarded-port']   = req.connection.remotePort || req.socket.remotePort;
    }

    if (req.headers['x-forwarded-proto']){
        var protoToAppend = "," + req.connection.pair ? 'https' : 'http';
        req.headers['x-forwarded-proto']   += protoToAppend;
    } else {
        req.headers['x-forwarded-proto']   = req.connection.pair ? 'https' : 'http';
    }

  }

  //
  // Emit the `start` event indicating that we have begun the proxy operation.
  //
  this.emit('start', req, res, this.target);

  //
  // If forwarding is enabled for this instance, foward proxy the
  // specified request to the address provided in `this.forward`
  //
  if (this.forward) {
    this.emit('forward', req, res, this.forward);
    this._forwardRequest(req);
  }

  //
  // #### function proxyError (err)
  // #### @err {Error} Error contacting the proxy target
  // Short-circuits `res` in the event of any error when
  // contacting the proxy target at `host` / `port`.
  //
  function proxyError(err) {
    errState = true;

    //
    // Emit an `error` event, allowing the application to use custom
    // error handling. The error handler should end the response.
    //
    if (self.emit('proxyError', err, req, res)) {
      return;
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });

    if (req.method !== 'HEAD') {
      //
      // This NODE_ENV=production behavior is mimics Express and
      // Connect.
      //
      if (process.env.NODE_ENV === 'production') {
        res.write('Internal Server Error');
      }
      else {
        res.write('An error has occurred: ' + JSON.stringify(err));
      }
    }

    try { res.end() }
    catch (ex) { console.error("res.end error: %s", ex.message) }
  }

  //
  // Setup outgoing proxy with relevant properties.
  //
  outgoing.host    = this.target.host;
  outgoing.port    = this.target.port;
  outgoing.agent   = this.target.agent;
  outgoing.method  = req.method;
  outgoing.path    = req.url;
  outgoing.headers = req.headers;

  //
  // Open new HTTP request to internal resource with will act 
  // as a reverse proxy pass
  //
  reverseProxy = this.target.protocol.request(outgoing, function (response) {
    //
    // Process the `reverseProxy` `response` when it's received.
    //
    if (response.headers.connection) {
      if (req.headers.connection) { response.headers.connection = req.headers.connection }
      else { response.headers.connection = 'close' }
    }

    // Remove `Transfer-Encoding` header if client's protocol is HTTP/1.0
    if (req.httpVersion === '1.0') {
      delete response.headers['transfer-encoding'];
    }

    // Set the headers of the client response
    res.writeHead(response.statusCode, response.headers);

    // If `response.statusCode === 304`: No 'data' event and no 'end'
    if (response.statusCode === 304) {
      try { res.end() }
      catch (ex) { console.error("res.end error: %s", ex.message) }
      return;
    }

    //
    // For each data `chunk` received from the `reverseProxy`
    // `response` write it to the outgoing `res`.
    // If the res socket has been killed already, then write()
    // will throw. Nevertheless, try our best to end it nicely.
    //
    var paused = false;
    response.on('data', function (chunk) {
      if (req.method !== 'HEAD' && res.writable) {
        try {
          var flushed = res.write(chunk);
        } 
        catch (ex) {
          console.error("res.write error: %s", ex.message);
          
          try { res.end() } 
          catch (ex) { console.error("res.end error: %s", ex.message) }
          
          return;
        }
        
        if (!flushed && !paused) {
          paused = true;
          response.pause();
          res.once('drain', function () {
            paused = false;
            try { response.resume() } 
            catch (er) { console.error("response.resume error: %s", er.message) }
          });
          
          //
          // Force the `drain` event in 100ms if it hasn't
          // happened on its own. 
          //          
          setTimeout(function () {
            res.emit('drain');
          }, 100);
        }
      }
    });

    //
    // When the `reverseProxy` `response` ends, end the
    // corresponding outgoing `res` unless we have entered
    // an error state. In which case, assume `res.end()` has
    // already been called and the 'error' event listener
    // removed.
    //
    var ended = false
    response.on('close', function () {
      if(!ended) response.emit('end')
    })
    response.on('end', function () {
      ended = true
      if (!errState) {
        reverseProxy.removeListener('error', proxyError);
        
        try { res.end() }
        catch (ex) { console.error("res.end error: %s", ex.message) }
        
        // Emit the `end` event now that we have completed proxying
        self.emit('end', req, res);
      }
    });
  });

  //
  // Handle 'error' events from the `reverseProxy`.
  //
  reverseProxy.once('error', proxyError);

  //
  // For each data `chunk` received from the incoming
  // `req` write it to the `reverseProxy` request.
  //
  req.on('data', function (chunk) {
    
    if (!errState) {
      var flushed = reverseProxy.write(chunk);
      if (!flushed) {
        req.pause();
        reverseProxy.once('drain', function () {
          try { req.resume() } 
          catch (er) { console.error("req.resume error: %s", er.message) }
        });
        
        //
        // Force the `drain` event in 100ms if it hasn't
        // happened on its own. 
        //
        setTimeout(function () {
          reverseProxy.emit('drain');
        }, 100);
      }
    }
  });

  //
  // When the incoming `req` ends, end the corresponding `reverseProxy`
  // request unless we have entered an error state.
  //
  req.on('end', function () {
    if (!errState) {
      reverseProxy.end();
    }
  });

  //Aborts reverseProxy if client aborts the connection.
  req.on('close', function () {
    if (!errState) {
      reverseProxy.abort();
    }
  });

  //
  // If we have been passed buffered data, resume it.
  //
  if (buffer) {
    return !errState
      ? buffer.resume()
      : buffer.destroy();
  }
};

//
// ### function close()
// Closes all sockets associated with the Agents
// belonging to this instance.
//
HttpProxy.prototype.close = function () {
  [this.forward, this.target].forEach(function (proxy) {
    if (proxy && proxy.agent) {
      for (var host in proxy.agent.sockets) {
        proxy.agent.sockets[host].forEach(function (socket) {
          socket.end();
        });
      }
    }
  });
};

//
// ### @private function _forwardRequest (req)
// #### @req {ServerRequest} Incoming HTTP Request to proxy.
// Forwards the specified `req` to the location specified
// by `this.forward` ignoring errors and the subsequent response.
//
HttpProxy.prototype._forwardRequest = function (req) {
  var self = this, 
      outgoing = new(this.forward.base),
      forwardProxy;

  //
  // Setup outgoing proxy with relevant properties.
  //
  outgoing.host    = this.forward.host;
  outgoing.port    = this.forward.port,
  outgoing.agent   = this.forward.agent;
  outgoing.method  = req.method;
  outgoing.path    = req.url;
  outgoing.headers = req.headers;

  //
  // Open new HTTP request to internal resource with will 
  // act as a reverse proxy pass.
  //
  forwardProxy = this.forward.protocol.request(outgoing, function (response) {
    //
    // Ignore the response from the forward proxy since this is a 'fire-and-forget' proxy.
    // Remark (indexzero): We will eventually emit a 'forward' event here for performance tuning.
    //
  });

  //
  // Add a listener for the connection timeout event.
  //
  // Remark: Ignoring this error in the event
  //         forward target doesn't exist.
  //
  forwardProxy.once('error', function (err) { });

  //
  // Chunk the client request body as chunks from
  // the proxied request come in
  //
  req.on('data', function (chunk) {
    var flushed = forwardProxy.write(chunk);
    if (!flushed) {
      req.pause();
      forwardProxy.once('drain', function () {
        try { req.resume() } 
        catch (er) { console.error("req.resume error: %s", er.message) }
      });

      //
      // Force the `drain` event in 100ms if it hasn't
      // happened on its own. 
      //
      setTimeout(function () {
        forwardProxy.emit('drain');
      }, 100);
    }
  });

  //
  // At the end of the client request, we are going to 
  // stop the proxied request
  //
  req.on('end', function () {
    forwardProxy.end();
  });
};
