'use strict'

module.exports = class SessionConnectionPair {
  constructor (connPair, session, baton) {
    this.pair = connPair
    this.session = session
    this.baton = baton

    // tightly bind "release", because we don't know
    // who will be calling it.
    this.release = err => release(this, err)
  }

  get connection () {
    return this.pair.connection
  }
}

// release: attempt to hand the connection pair to the next
// in the list of waiting receivers. If there are none, release
// the connection entirely. This lets us limit the concurrency
// per-request, instead of globally.
function release (conn, err) {
  conn.session.metrics.onConnectionFinish(conn.baton, err)
  if (err) {
    return handleError(conn, err)
  }
  const next = conn.session.pending.shift()
  if (next) {
    return next.resolve(conn)
  }
  conn.session.metrics.onSessionIdle()
  conn.session.releasePair(conn.pair, null)
}

// handleError: release the connection back to the pg pool
// with the error notification; replay all pending connections
// so they don't try to grab this one.
function handleError (conn, err) {
  conn.session.releasePair(conn.pair, err)

  const pending = conn.session.pending.slice()
  conn.session.pending.length = 0
  pending.forEach(xs => {
    conn.session.getConnection().then(ys => xs.resolve(ys))
  })
}
