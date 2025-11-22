"use strict";

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const url = require("url");

const AccountManager = require("./account-manager");
const AccountDB = require("./account-db");

const LoginServer = function(callback) {

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

LoginServer.prototype.__init = function() {

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

LoginServer.prototype.__handleExit = function(exit) {

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

LoginServer.prototype.__generateToken = function(name) {

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

LoginServer.prototype.__isValidCreateAccount = function(queryObject) {

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

LoginServer.prototype.__createAccount = function(request, response) {

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
  AccountDB.findAccount(account, function(err, row) {

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
    this.accountManager.createAccount(queryObject, function(error, accountObject) {

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
        function(err2) {

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
            function(err3) {

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
   * Handles incoming HTTP requests
   */

  // Enabled CORS to allow requests from JavaScript
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");

  // Only GET (for tokens) and POST (for account creation)
  if (request.method !== "GET" && request.method !== "POST") {
    response.statusCode = 501;
    return response.end();
  }

  // POST means creating account
  if (request.method === "POST") {
    return this.__createAccount(request, response);
  }

  // Data submitted in the querystring (GET / login)
  let requestObject = url.parse(request.url, true);

  if (requestObject.pathname !== "/") {
    response.statusCode = 404;
    return response.end();
  }

  let queryObject = requestObject.query;
  console.log("[LOGIN] Petición de login:", queryObject);

  // Account or password were not supplied
  if (!queryObject.account || !queryObject.password) {
    response.statusCode = 401;
    return response.end();
  }

  let account  = queryObject.account;
  let password = queryObject.password;

  // Buscar la cuenta en la base de datos
  AccountDB.findAccount(account, function(err, row) {

      if (err) {
    console.error("[LOGIN] Error buscando cuenta en DB:", err);
    response.statusCode = 500;
    return response.end();
  }

  if (!row) {
    console.warn("[LOGIN] Cuenta no encontrada:", account);
    response.statusCode = 401;
    return response.end();
  }

  console.log("[LOGIN] Cuenta encontrada:", row.account);

  bcrypt.compare(password, row.hash, function(error, result) {

    if (error) {
      console.error("[LOGIN] Error en bcrypt.compare:", error);
      response.statusCode = 500;
      return response.end();
    }

    if (!result) {
      console.warn("[LOGIN] Password incorrecta para account:", account);
      response.statusCode = 401;
      return response.end();
    }

    console.log("[LOGIN] Login correcto para account:", account);

      // Login válido → devolver HMAC token para el GameServer
      response.writeHead(200, {"Content-Type": "application/json"});

      response.end(JSON.stringify({
        "token": Buffer.from(
          JSON.stringify(this.__generateToken(row.definition))
        ).toString("base64"),
        "host": CONFIG.SERVER.EXTERNAL_HOST
      }));

    }.bind(this));

  }.bind(this));

};

module.exports = LoginServer;