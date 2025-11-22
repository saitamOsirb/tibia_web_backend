"use strict";

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const url = require("url");

const AccountManager = require("./account-manager");
const AccountDB = require("./account-db");

const LoginServer = function (callback) {

  /*
   * Class LoginServer
   *
   * Wrapper for the Forby HTML5 Open Tibia Server
   * Checks database of accounts / bcrypt passwords and returns a HMAC token to be provided to the gameserver
   * The gameserver uses the validity of the HMAC token to allow a websocket connection and load the required account file
   *
   */

  // Inicializar estructura de cuentas (carpetas para los JSON de player)
  this.__init();

  // Inicializar base de datos de cuentas (PostgreSQL)
  AccountDB.initDatabase();

  // Ya no usamos this.accounts para login, pero lo dejamos por compatibilidad / posibles usos futuros
  this.accounts = {};

  this.accountManager = new AccountManager();

  // Create the server and handler
  this.server = http.createServer(this.__handleRequest.bind(this));

  // Graceful close
  process.on("SIGINT", this.server.close.bind(this.server));
  process.on("SIGTERM", this.server.close.bind(this.server));
  process.on("exit", this.__handleExit.bind(this));
  //process.on("uncaughtException", process.exit.bind(this, 1));

  // Listen for incoming requests
  this.server.listen(CONFIG.LOGIN.PORT, CONFIG.LOGIN.HOST, callback);

};

LoginServer.prototype.__init = function () {

  /*
   * LoginServer.__init
   * Initializes the login server and handles creation of account directory if it does not exist
   */

  // If accounts does not exist create the folder and necessary files
  try {
    fs.accessSync(getDataFile("accounts"));
  } catch (error) {
    fs.mkdirSync(getDataFile("accounts"));
    fs.writeFileSync(getDataFile("accounts", "accounts.json"), "{}");
    fs.mkdirSync(getDataFile("accounts", "definitions"));
  }

};

LoginServer.prototype.__handleExit = function (exit) {

  /*
   * LoginServer.__handleExit
   * Antes guardaba this.accounts en accounts.json.
   * Ahora las cuentas reales están en PostgreSQL, así que esto es opcional.
   */

  fs.writeFileSync(
    getDataFile("accounts", "accounts.json"),
    JSON.stringify(this.accounts, null, 2)
  );

};

LoginServer.prototype.__generateToken = function (name) {

  /*
   * LoginServer.__generateToken
   * Generates a simple HMAC token for the client to identify itself with.
   */

  // Token is only valid for a few seconds
  let expire = Date.now() + 3000;

  // Return the JSON payload
  return new Object({
    "name": name,
    "expire": expire,
    "token": crypto
      .createHmac("sha256", CONFIG.HMAC.SHARED_SECRET)
      .update(name + expire)
      .digest("hex")
  });

};

LoginServer.prototype.__isValidCreateAccount = function (queryObject) {

  /*
   * LoginServer.__isValidCreateAccount
   * Returns true if the request to create the account is valid
   */

  // Missing
  if (!queryObject.account || !queryObject.password || !queryObject.name || !queryObject.sex) {
    return false;
  }

  // Accept only lower case letters for the character name
  if (!/^[a-z]+$/.test(queryObject.name)) {
    return false;
  }

  // Must be male or female
  if (queryObject.sex !== "male" && queryObject.sex !== "female") {
    return false;
  }

  return true;

};

LoginServer.prototype.__createAccount = function (request, response) {

  /*
   * LoginServer.__createAccount
   * Crea una nueva cuenta usando AccountManager (para el JSON del personaje)
   * y PostgreSQL (para guardar account + hash + player JSON)
   */

  let queryObject = url.parse(request.url, true).query;

  // Validación básica de parámetros
  if (!this.__isValidCreateAccount(queryObject)) {
    response.statusCode = 400;
    return response.end();
  }

  let account = queryObject.account;

  // 1) Comprobar si ya existe la cuenta en la base de datos
  AccountDB.findAccount(account, function (err, row) {

    if (err) {
      console.error("[LOGIN] Error comprobando cuenta en DB:", err);
      response.statusCode = 500;
      return response.end();
    }

    if (row) {
      // La cuenta ya existe
      response.statusCode = 409;
      return response.end();
    }

    // 2) Crear el personaje / archivo JSON como antes (AccountManager)
    this.accountManager.createAccount(queryObject, function (error, accountObject) {

      // Fallo creando la cuenta (AccountManager)
      if (error) {
        response.statusCode = error;
        return response.end();
      }

      // accountObject = { hash, definition, playerData }

      // 3) Guardar cuenta en tabla accounts
      AccountDB.insertAccount(
        account,
        accountObject.hash,
        accountObject.definition,
        function (err2) {

          if (err2) {
            console.error("[LOGIN] Error insertando cuenta en DB:", err2);
            response.statusCode = 500;
            return response.end();
          }

          // 4) Guardar player en tabla players (ahora la FK ya existe)
          AccountDB.savePlayerData(
            accountObject.definition,   // name del personaje
            account,                    // número de cuenta
            accountObject.playerData,   // JSON completo del player
            function (err3) {

              if (err3) {
                console.error("[LOGIN] Error guardando player en DB:", err3);
                response.statusCode = 500;
                return response.end();
              }

              // 5) Respuesta OK
              response.statusCode = 201;
              response.end();

            }
          );

        }.bind(this)
      );

    }.bind(this));

  }.bind(this));

};

LoginServer.prototype.__handleRequest = function(request, response) {

  /*
   * LoginServer.__handleRequest
   * Maneja todas las peticiones HTTP del login server
   */

  // CORS básico
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.statusCode = 200;
    return response.end();
  }

  // Solo aceptamos GET y POST
  if (request.method !== "GET" && request.method !== "POST") {
    response.statusCode = 501;
    return response.end();
  }

  const requestObject = url.parse(request.url, true);
  const pathname      = requestObject.pathname;

  /*
   * ==========================================================
   *  RUTA: POST /characters
   *  Crea un nuevo personaje para una cuenta existente.
   *  Body JSON: { account, password, name, sex }
   * ==========================================================
   */
  if (request.method === "POST" && pathname === "/characters") {

    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", function() {
      let data;

      try {
        data = JSON.parse(body);
      } catch (e) {
        response.statusCode = 400;
        response.write(JSON.stringify({ error: "INVALID_JSON" }));
        return response.end();
      }

      let { account, password, name, sex } = data || {};

      if (!account || !password || !name || !sex) {
        response.statusCode = 400;
        response.write(JSON.stringify({ error: "MISSING_FIELDS" }));
        return response.end();
      }

      // 1) Validar cuenta + password con la misma lógica de siempre
      this.__authAccount(account, password, function(err, accountRow) {
        if (err) {
          if (err.message === "ACCOUNT_NOT_FOUND" || err.message === "INVALID_PASSWORD") {
            response.statusCode = 401;
            response.write(JSON.stringify({ error: err.message }));
            return response.end();
          }

          console.error("[LOGIN] Error auth POST /characters:", err);
          response.statusCode = 500;
          response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
          return response.end();
        }

        // 2) Asegurarnos de que el nombre de personaje no exista ya
        AccountDB.loadPlayerData(name.toLowerCase(), function(err, existing) {
          if (err) {
            console.error("[LOGIN] Error comprobando nombre:", err);
            response.statusCode = 500;
            response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
            return response.end();
          }

          if (existing) {
            response.statusCode = 409;
            response.write(JSON.stringify({ error: "NAME_TAKEN" }));
            return response.end();
          }

          // 3) Usar AccountManager.__getCharacterBlueprint para generar el PJ
          const charQueryObject = {
            name: name,
            sex: sex
          };

          // Devuelve un STRING JSON con el blueprint completo del personaje
          const playerDataString = this.accountManager.__getCharacterBlueprint(charQueryObject);

          let playerData;
          try {
            // Lo convertimos a objeto JS para guardarlo como JSON/JSONB en la BD
            playerData = JSON.parse(playerDataString);
          } catch (e) {
            console.error("[LOGIN] Error parseando blueprint de personaje:", e);
            response.statusCode = 500;
            response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
            return response.end();
          }

          // 4) Guardar el nuevo personaje en la tabla players
          AccountDB.savePlayerData(
            name.toLowerCase(),   // name: en minúsculas
            account,              // número de cuenta
            playerData,           // JSON completo del personaje
            function(err2) {
              if (err2) {
                console.error("[LOGIN] Error guardando nuevo personaje:", err2);
                response.statusCode = 500;
                response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
                return response.end();
              }

              response.writeHead(201, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ ok: true, name }));
            }
          );

        }.bind(this));
      }.bind(this));
    }.bind(this));

    return;
  }

  /*
   * ==========================================================
   *  RUTA: POST /  (crear cuenta)
   *  Se deja igual que en tu código original
   * ==========================================================
   */
  if (request.method === "POST" && pathname === "/") {
    return this.__createAccount(request, response);
  }

  /*
   * ==========================================================
   *  RUTA: GET /characters
   *  Lista todos los personajes de una cuenta
   *  Parámetros: ?account=...&password=...
   * ==========================================================
   */
  if (request.method === "GET" && pathname === "/characters") {
    const q = requestObject.query;

    if (!q.account || !q.password) {
      response.statusCode = 400;
      response.write(JSON.stringify({ error: "MISSING_CREDENTIALS" }));
      return response.end();
    }

    this.__authAccount(q.account, q.password, function(err, accountRow) {
      if (err) {
        if (err.message === "ACCOUNT_NOT_FOUND" || err.message === "INVALID_PASSWORD") {
          response.statusCode = 401;
          response.write(JSON.stringify({ error: err.message }));
          return response.end();
        }

        console.error("[LOGIN] Error auth GET /characters:", err);
        response.statusCode = 500;
        response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
        return response.end();
      }

      AccountDB.listCharactersByAccount(q.account, function(err, rows) {
        if (err) {
          console.error("[LOGIN] Error listando personajes:", err);
          response.statusCode = 500;
          response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
          return response.end();
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          account: q.account,
          characters: rows.map(r => ({
            name: r.name
            // aquí podrías parsear r.data para exponer level, voc, etc
          }))
        }));
      });
    }.bind(this));

    return;
  }

  /*
   * ==========================================================
   *  RUTA: GET /login-character
   *  Genera un token para un personaje concreto
   *  Parámetros: ?account=...&password=...&name=...
   * ==========================================================
   */
  if (request.method === "GET" && pathname === "/login-character") {
    const q = requestObject.query;

    if (!q.account || !q.password || !q.name) {
      response.statusCode = 400;
      response.write(JSON.stringify({ error: "MISSING_FIELDS" }));
      return response.end();
    }

    this.__authAccount(q.account, q.password, function(err, accountRow) {
      if (err) {
        if (err.message === "ACCOUNT_NOT_FOUND" || err.message === "INVALID_PASSWORD") {
          response.statusCode = 401;
          response.write(JSON.stringify({ error: err.message }));
          return response.end();
        }

        console.error("[LOGIN] Error auth GET /login-character:", err);
        response.statusCode = 500;
        response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
        return response.end();
      }

      // Confirmar que el personaje pertenece a esta cuenta
      AccountDB.listCharactersByAccount(q.account, function(err, rows) {
        if (err) {
          console.error("[LOGIN] Error listando personajes en /login-character:", err);
          response.statusCode = 500;
          response.write(JSON.stringify({ error: "INTERNAL_ERROR" }));
          return response.end();
        }

        const found = rows.find(r => r.name.toLowerCase() === q.name.toLowerCase());

        if (!found) {
          response.statusCode = 403;
          response.write(JSON.stringify({ error: "CHARACTER_DOES_NOT_BELONG_TO_ACCOUNT" }));
          return response.end();
        }

        // Generar token usando el nombre del personaje
        const tokenObject = this.__generateToken(q.name);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          token: Buffer.from(JSON.stringify(tokenObject)).toString("base64"),
          host: CONFIG.SERVER.EXTERNAL_HOST
        }));
      }.bind(this));
    }.bind(this));

    return;
  }

  /*
   * ==========================================================
   *  RUTA: GET /  (login normal de cuenta)
   *  Igual que tenías antes
   * ==========================================================
   */

  // Cualquier otra ruta GET ≠ "/" es 404
  if (request.method === "GET" && pathname !== "/") {
    response.statusCode = 404;
    return response.end();
  }

  const queryObject = requestObject.query;

  // Falta account o password
  if (!queryObject.account || !queryObject.password) {
    response.statusCode = 401;
    return response.end();
  }

  const account  = queryObject.account;
  const password = queryObject.password;

  AccountDB.findAccount(account, function(err, row) {

    if (err) {
      console.error("[LOGIN] Error buscando cuenta en DB:", err);
      response.statusCode = 500;
      return response.end();
    }

    // Cuenta no existe
    if (!row) {
      response.statusCode = 401;
      return response.end();
    }

    // Comparar password
    bcrypt.compare(password, row.hash, function(error, result) {

      if (error) {
        response.statusCode = 500;
        return response.end();
      }

      if (!result) {
        response.statusCode = 401;
        return response.end();
      }

      // Login válido → devolver token y host
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        token: Buffer.from(
          JSON.stringify(this.__generateToken(row.definition))
        ).toString("base64"),
        host: CONFIG.SERVER.EXTERNAL_HOST
      }));

    }.bind(this));

  }.bind(this));

};

LoginServer.prototype.__authAccount = function (account, password, callback) {
  /*
   * Valida account + password usando la misma lógica que el login normal.
   * callback(err, accountRow)
   */

  AccountDB.findAccount(account, function (err, row) {
    if (err) return callback(err);

    if (!row) {
      // cuenta no existe
      return callback(new Error("ACCOUNT_NOT_FOUND"));
    }

    bcrypt.compare(password, row.hash, function (error, result) {
      if (error) return callback(error);
      if (!result) return callback(new Error("INVALID_PASSWORD"));

      // credenciales OK → devolvemos la fila
      callback(null, row);
    });
  });
};



module.exports = LoginServer;