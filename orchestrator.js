/**
 * orchestrator.js
 *
 * Biblioteca de orquestación de contenedores Docker para Wiazart Multi-Tenant.
 * Administra el ciclo de vida de los contenedores de los usuarios en el puerto VPS.
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Rango de puertos reservados para workspaces de usuarios
const PORT_START = 9000;
const PORT_END = 9999;

// Rutas base en el VPS para almacenar datos de usuario aislados
const BASE_USERS_DIR = '/opt/wiazart-users';
const TEMPLATE_SQLITE_PATH = '/opt/projects/wiazart-server/userData/sqlite.db';

/**
 * Utilidad para ejecutar comandos shell asíncronos con promesas
 */
function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Asegura que la columna `workspace_port` existe en la tabla de usuarios.
 */
async function ensureOrchestratorSchema(pool) {
  const conn = await pool.getConnection();
  try {
    // Comprobar si existe la columna workspace_port
    const [columns] = await conn.query("SHOW COLUMNS FROM users LIKE 'workspace_port'");
    if (columns.length === 0) {
      console.log('[ORCHESTRATOR] ✦ Agregando columna workspace_port a la tabla users...');
      await conn.query('ALTER TABLE users ADD COLUMN workspace_port INT DEFAULT NULL');
      console.log('[ORCHESTRATOR] ✓ Columna agregada con éxito.');
    }
  } catch (err) {
    console.error('[ORCHESTRATOR] ✗ Error al inicializar esquema de base de datos:', err);
  } finally {
    conn.release();
  }
}

/**
 * Encuentra un puerto libre secuencial en la base de datos entre 9000 y 9999.
 */
async function findNextAvailablePort(pool) {
  const [rows] = await pool.query('SELECT workspace_port FROM users WHERE workspace_port IS NOT NULL');
  const usedPorts = new Set(rows.map(r => r.workspace_port));
  
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!usedPorts.has(port)) {
      // Opcional: verificar mediante shell si el puerto está realmente libre en el sistema
      try {
        execSync(`netstat -lnt | grep :${port}`);
        // Si no arrojó error, significa que el puerto está ocupado, continuamos buscando
      } catch (e) {
        // Si netstat da error (código de salida no cero), el puerto está libre
        return port;
      }
    }
  }
  throw new Error('No hay puertos disponibles en el rango multi-tenant (9000-9999)');
}

/**
 * Obtiene o crea el Workspace para un usuario.
 * Retorna el puerto (port) asignado al contenedor del usuario.
 */
async function getOrCreateWorkspace(pool, userId, email) {
  // Limpiar caracteres especiales de email para uso en nombre de directorios y docker
  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const containerName = `wiazart-workspace-${userId}`;
  
  // 1. Verificar si el usuario ya tiene puerto asignado en la base de datos
  const [users] = await pool.query('SELECT workspace_port FROM users WHERE user_id = ?', [userId]);
  if (users.length === 0) {
    throw new Error('Usuario no encontrado');
  }
  
  let port = users[0].workspace_port;
  
  // 2. Si no tiene puerto, asignarle uno nuevo libre
  if (!port) {
    console.log(`[ORCHESTRATOR] Asignando puerto nuevo para usuario: ${email}`);
    port = await findNextAvailablePort(pool);
    await pool.query('UPDATE users SET workspace_port = ? WHERE user_id = ?', [port, userId]);
    console.log(`[ORCHESTRATOR] Puerto ${port} asignado con éxito a ${email}`);
  }
  
  // 3. Crear directorios persistentes para el usuario en el VPS
  const userDir = path.join(BASE_USERS_DIR, userId);
  const userDataDir = path.join(userDir, 'userData');
  const userAppsDir = path.join(userDir, 'wiazart-apps');
  
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`[ORCHESTRATOR] Creado directorio de datos en VPS: ${userDataDir}`);
  }
  if (!fs.existsSync(userAppsDir)) {
    fs.mkdirSync(userAppsDir, { recursive: true });
    console.log(`[ORCHESTRATOR] Creado directorio de proyectos en VPS: ${userAppsDir}`);
  }
  
  // 4. Inicializar base de datos SQLite si está ausente copiándola de la plantilla actual
  const userSqlitePath = path.join(userDataDir, 'sqlite.db');
  if (!fs.existsSync(userSqlitePath) && fs.existsSync(TEMPLATE_SQLITE_PATH)) {
    try {
      fs.copyFileSync(TEMPLATE_SQLITE_PATH, userSqlitePath);
      console.log(`[ORCHESTRATOR] Base de datos SQLite pre-inicializada para el usuario: ${email}`);
    } catch (e) {
      console.error(`[ORCHESTRATOR] ⚠️ No se pudo copiar la plantilla SQLite:`, e.message);
    }
  }
  
  // 5. Verificar estado del contenedor Docker y actualizar si la imagen cambió
  try {
    const inspectResult = await runCmd(`docker inspect -f '{{.State.Status}}' ${containerName}`);
    const inspectImage = await runCmd(`docker inspect -f '{{.Image}}' ${containerName}`);
    const latestImage = await runCmd(`docker inspect -f '{{.Id}}' wiazart-headless:latest`);
    
    if (inspectImage !== latestImage) {
      console.log(`[ORCHESTRATOR] ✦ Contenedor ${containerName} utiliza una imagen desactualizada. Recreando con la nueva versión...`);
      try { await runCmd(`docker stop ${containerName}`); } catch (e) {}
      try { await runCmd(`docker rm ${containerName}`); } catch (e) {}
      throw new Error('image_mismatch'); // Forzar la recreación en el bloque catch
    }
    
    if (inspectResult === 'running') {
      console.log(`[ORCHESTRATOR] Contenedor ${containerName} ya está activo en puerto ${port}.`);
      return port;
    } else {
      console.log(`[ORCHESTRATOR] Iniciando contenedor existente ${containerName} (Estado actual: ${inspectResult})...`);
      await runCmd(`docker start ${containerName}`);
      return port;
    }
  } catch (err) {
    // Si da error (no existe o desactualizado), procedemos a crearlo.
    console.log(`[ORCHESTRATOR] Creando y levantando nuevo contenedor Docker: ${containerName} en puerto ${port}...`);
    
    // Comando docker run
    const dockerCmd = [
      'docker run -d',
      `--name ${containerName}`,
      '--restart unless-stopped',
      `-p 127.0.0.1:${port}:8080`,
      `-v ${userAppsDir}:/root/wiazart-apps`,
      `-v ${userDataDir}:/app/wiazart-server/userData`,
      '-v /opt/projects/wiazart-server/src:/app/wiazart-server/src',
      '-v /opt/projects/wiazart-server/public:/app/wiazart-server/public',
      `-e WIAZART_ENCRYPTION_KEY=wiazart-production-secure-key-2026`,
      `-e PORT=8080`,
      'wiazart-headless:latest'
    ].join(' ');
    
    await runCmd(dockerCmd);
    console.log(`[ORCHESTRATOR] ¡Contenedor Docker ${containerName} levantado y en funcionamiento en puerto ${port}!`);
  }
  
  return port;
}

/**
 * Detiene todos los contenedores inactivos para liberar memoria en el VPS (Auto-Scaling / Recolección de basura).
 * Puede ser programado para ejecutarse cada hora.
 */
async function pruneInactiveWorkspaces() {
  console.log('[ORCHESTRATOR] Buscando contenedores para liberar recursos...');
  try {
    const runningContainers = await runCmd(`docker ps --filter "name=wiazart-workspace-" --format "{{.Names}}"`);
    if (!runningContainers) return;
    
    const names = runningContainers.split('\n');
    for (const name of names) {
      // Detiene el contenedor (puedes expandir esto para comprobar tiempo de inactividad de conexión si es necesario)
      // Por ahora solo listamos esta capacidad para futuro uso de auto-apagado
      console.log(`[ORCHESTRATOR] Capacidad de auto-apagado disponible para: ${name}`);
    }
  } catch (e) {
    console.error('[ORCHESTRATOR] Error durante prune:', e.message);
  }
}

module.exports = {
  ensureOrchestratorSchema,
  getOrCreateWorkspace,
  pruneInactiveWorkspaces
};
