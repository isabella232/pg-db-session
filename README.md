# pg-db-session

Abuse domains to get a form of continuation local storage. Associate all events
originating from a single domain to a single database session, which manages
maximum concurrency, transactions, and operation ordering for consumers of the
database connection.

```javascript
const db = require('pg-db-session')
const domain = require('domain')
const http = require('http')
const pg = require('pg')

http.createServer((req, res) => {
  const d = domain.create()
  d.add(req)
  d.add(res)

  db.install(d, () => {
    return new Promise((resolve, reject) => {
      pg.connect(CONFIG, (err, connection, release) => {
        err ? reject(err) : resolve({connection, release})
      })
    })
  }, {maxConcurrency: 2})

  d.run(() => {
    // handle some code.
    someOperation()
    someAtomic()
  })
})

const someOperation = db.transaction(function operation () {
  // this code will always run inside an operation
  return db.getConnection().then(pair => {
    pair.connection.query('DELETE FROM all', err => pair.release(err))
  })
})

const someAtomic = db.atomic(function atom () {
  // this code will always be run inside an operation together,
  // with savepoints.
})
```

Database sessions are active whenever their associated domain is active. This means
that a domain can be associated with a request, and all requests for a connection
will be managed by the session associated with that domain.

Database sessions manage access to the lower-level postgres connection pool.
This lets users specify maximum concurrency for a given session — for instance,
retaining a pool of 20 connections, but only allotting a maximum of 4
concurrent connections per incoming HTTP request.

Sessions also manage *transaction* status — functions may be decorated with
"transaction" or "atomic" wrappers, and the active session will automatically
create a transactional sub-session for the execution of those functions and any
subsequent events they spawn. Any requests for a connection will be handled by
the subsession. The transaction held by the subsession will be committed or
rolled back based on the fulfillment status of the promise returned by the
wrapped function. Transactional sessions hold a single connection, releasing it
to connection requests sequentially — this naturally reduces the connection
concurrency to one.

Atomics, like transactions, hold a single connection, delegating sequentially.
They're useful for grouping a set of operations atomically within a
transaction. Atomics are wrapped in a `SAVEPOINT` — releasing the savepoint if
the promise returned by the wrapped function is fulfilled, and rolling back to
it if the promise is rejected. Atomics may be nested.

## API

#### `db.install(d:Domain, getConnection:ConnPairFn, opts:Options)`

Install a database `Session` on the domain `d`.

##### `Options`

Sessions accept the following options:

<img align="right" src="https://cloud.githubusercontent.com/assets/37303/12259904/985ef78a-b8cd-11e5-8665-0535caa69334.png" alt="assets/event-flowchart.dot" />

* `maxConcurrency`: An integer specifying the maximum number of connections a
  given session will make at a time. `0` is treated as `Infinity`. Defaults to
  `Infinity`. *Note:* this number is implicitly bound by the size of the `pg`
  connection pool. For example, even if the limit is set at `200`, if `pg`'s
  pool size is limited to `10`, the upper limit will effectively be `10`.
* `onSessionIdle()`: A function that is called whenever all requests for
  connections have been satisfied. Note that this may happen while connections
  are still open.
* `onConnectionRequest(baton)`: A function accepting a baton object that is
  called when a request for a connection is made.
* `onConnectionStart(baton)`: A function acccepting a baton object that is
  called when a request for a connection is fulfilled. The baton will be the
  same object that was passed to a previous call to `onConnectionRequest`,
  suitable for associating timing information.
* `onConnectionFinish(baton, err)`: A function accepting a baton object and
  an optional `err` parameter that will be called when a connection is released
  back to the session.
* `onTransactionRequest(baton, operation, args)`: A function accepting a baton,
  function, and array of arguments, representing the request for a transaction
  session. Called coincident with `onConnectionRequest`.
* `onTransactionStart(baton, operation, args)`: A function accepting a baton,
  function, and array of arguments, representing the fulfillment of a request
  for a transaction session. Called before `BEGIN`, coincident with
  `onConnectionStart`.
* `onTransactionFinish(baton, operation, args, PromiseInspection)`:
  A function accepting a baton, function, array of arguments, and a
  [`PromiseInspection`][bluebird-inspection] representing the state of the
  transaction. Called coincident with `onConnectionFinish`.
* `onTransactionConnectionRequest(baton)`: A function accepting a baton,
  representing the request for a connection within a transaction session.
* `onTransactionConnectionStart(baton)`: A function accepting a baton,
  representing the fulfillment of a request for a connection within a
  transaction session.
* `onTransactionConnectionFinish(baton, err)`: A function accepting a baton
  and an optional `err` argument, representing the completion of a transaction
  connection within a transaction session.
* `onAtomicRequest(baton, operation, args)`: A function accepting a baton,
  function, and array of arguments, representing the request for an atomic
  session.
* `onAtomicStart(baton, operation, args)`: A function accepting a baton,
  function, and array of arguments, representing the fulfillment of a request
  for an atomic session.
* `onAtomicFinish(baton, operation, args, PromiseInspection)`:
  A function accepting a baton, function, array of arguments, and a
  [`PromiseInspection`][bluebird-inspection] representing the state of the
  atomic transaction.
* `onSubsessionStart(parentSession, childSession)`: Useful for copying
  information down from parent sessions to child sessions.
* `onSubsessionFinish(parentSession, childSession)`: Useful for cleaning up
  information from child sessions.

All functions will default to `noop` if not provided.

##### `ConnPairFn := Function → Promise({connection, release})`

A function that returns a `Promise` for an object with `connection` and `release`
properties, corresponding to the `client` and `done` parameters handed back by
[node-postgres][].

Usually, this will look something like the following:

```javascript
function getConnection () {
  return new Promise((resolve, reject) => {
    pg.connect(CONNECTION_OPTIONS, (err, client, done) => {
      err ? reject(err) : resolve({
        connection: client,
        release: done
      })
    })
  })
}
```

#### `db.getConnection() → Promise({connection, release})`

Request a connection pair. `release` should be called when the connection is no
longer necessary.

#### `db.transaction(Function → Promise<T>) → Function`

Wrap a function as requiring a transaction.

```javascript
const updateUser = db.atomic(function _updateUser(userId, name) {
  const getPair = db.getConnection()
  const queryDB = getPair.get('connection').then(conn => {
    return Promise.promisify(conn.query, {context: conn})(
      'UPDATE users SET name = $1 WHERE id = $2', [name, userId]
    )
  })
  const releaseConn = queryDB.return(getPair.get('release'))
    .then(release => release())
  return releaseConn.return(queryDB)
})

// from inside an active session:
updateUser(1313, 'gary').then(results => {

})
```

#### `db.atomic(Function → Promise<T>) → Function`

Wrap a function as an atomic. This groups all pending connection requests made by
the function and all subsequent events the function calls together, such that they
are resolved before any other pending requests. This is useful for operations that
stretch multiple queries, for example if you had to:

1. Fetch some data,
2. then insert a row in one table,
3. and then insert a row in another table,

One might write that as an atomic function so that the three operations are grouped
despite being spaced out temporally.

[node-postgres]: https://github.com/brianc/node-postgres
[bluebird-inspection]: http://bluebirdjs.com/docs/api/promiseinspection.html
