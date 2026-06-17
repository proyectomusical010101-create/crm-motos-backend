// CRM DE SERVICIO Y GARANTÍAS - SERVIDOR BACKEND REST API DE PRODUCCIÓN
// Tecnologías: Node.js, Express, Prisma ORM, JWT, Postgres

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'crm_motos_secret_key_2026';

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Permitir firmas base64 y fotos en JSON

// ==========================================
// MIDDLEWARES DE SEGURIDAD Y ROLES
// ==========================================

// 1. Middleware de Autenticación por JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token no provisto o no autorizado.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sesión expirada o token inválido.' });
    req.user = user;
    next();
  });
};

// 2. Guard de Roles y Permisos
const checkRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Acceso denegado: Permisos insuficientes para tu rol.' });
    }
    next();
  };
};

// Helper para bitácora de auditoría automática
const logAudit = async (usuarioId, accion, tabla, registroId, detalles) => {
  try {
    await prisma.auditoria.create({
      data: { usuarioId, accion, tablaAfectada: tabla, registroId, detalles }
    });
  } catch (err) {
    console.error('Error al registrar auditoría:', err);
  }
};

// ==========================================
// RUTAS DE AUTENTICACIÓN
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.usuario.findUnique({
      where: { email },
      include: { rol: true }
    });
    if (!user || !user.activo) return res.status(401).json({ error: 'Credenciales incorrectas o usuario inactivo.' });

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) return res.status(401).json({ error: 'Credenciales incorrectas.' });

    const token = jwt.sign(
      { id: user.id, nombre: user.nombre, rol: user.rol.nombre },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol.nombre } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// API REST: CLIENTES (CRUD)
// ==========================================

app.get('/api/clientes', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.cliente.findMany({
      include: { motocicletas: true, ordenesServicio: true }
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clientes', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  try {
    const newClient = await prisma.cliente.create({ data: req.body });
    await logAudit(req.user.id, 'CREATE', 'clientes', newClient.id, `Registro cliente: ${newClient.nombreCompleto}`);
    res.status(201).json(newClient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/clientes/:id', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await prisma.cliente.update({
      where: { id },
      data: req.body
    });
    await logAudit(req.user.id, 'UPDATE', 'clientes', id, `Modificación cliente: ${updated.nombreCompleto}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/clientes/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.cliente.delete({ where: { id } });
    await logAudit(req.user.id, 'DELETE', 'clientes', id, `Eliminación lógica/física de cliente ID: ${id}`);
    res.json({ message: 'Cliente eliminado correctamente.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/clientes/importar-masivo', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'El cuerpo de la petición debe ser una lista de registros.' });
  }

  try {
    let clientesCreados = 0;
    let motosCreadas = 0;
    let skippedMotos = 0;

    await prisma.$transaction(async (tx) => {
      for (const row of records) {
        const { nombreCompleto, email, telefono, moto } = row;
        if (!nombreCompleto || !moto || !moto.vin) continue;

        // 1. Resolver o crear cliente
        let cliente = null;
        if (email) {
          cliente = await tx.cliente.findFirst({
            where: {
              OR: [
                { email: { equals: email, mode: 'insensitive' } },
                { nombreCompleto: { equals: nombreCompleto, mode: 'insensitive' } }
              ]
            }
          });
        } else {
          cliente = await tx.cliente.findFirst({
            where: { nombreCompleto: { equals: nombreCompleto, mode: 'insensitive' } }
          });
        }

        if (!cliente) {
          cliente = await tx.cliente.create({
            data: {
              nombreCompleto,
              email: email || null,
              telefono: telefono || 'N/A'
            }
          });
          clientesCreados++;
        }

        // 2. Resolver o crear motocicleta
        const motoExists = await tx.motocicleta.findUnique({
          where: { vin: moto.vin }
        });

        if (!motoExists) {
          const fechaCompra = new Date();
          const fechaGarantiaLimite = new Date();
          fechaGarantiaLimite.setFullYear(fechaGarantiaLimite.getFullYear() + 2); // 2 años de garantía por defecto

          await tx.motocicleta.create({
            data: {
              clienteId: cliente.id,
              marca: moto.marca || 'VENTO',
              modelo: moto.modelo,
              vin: moto.vin,
              anio: moto.anio || 2026,
              color: 'N/A',
              numeroMotor: 'N/A',
              kilometraje: 0,
              fechaCompra,
              fechaGarantiaLimite,
              estadoGarantia: 'ACTIVA'
            }
          });
          motosCreadas++;
        } else {
          skippedMotos++;
        }
      }
    }, {
      maxWait: 60000, // Tiempo de espera para la conexión de DB
      timeout: 120000 // Aumentado a 120 segundos para importar lotes grandes de más de 500 filas
    });

    await logAudit(req.user.id, 'CREATE', 'clientes', 'masivo', `Importación masiva: ${clientesCreados} clientes y ${motosCreadas} motocicletas cargadas (${skippedMotos} motos duplicadas omitidas).`);
    
    res.json({
      success: true,
      clientesCreados,
      motosCreadas,
      skippedMotos
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// API REST: MOTOCICLETAS (CRUD)
// ==========================================

app.get('/api/motocicletas', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.motocicleta.findMany({ include: { cliente: true } });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/motocicletas', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  try {
    const moto = await prisma.motocicleta.create({ data: req.body });
    await logAudit(req.user.id, 'CREATE', 'motocicletas', moto.id, `Ingreso de moto: ${moto.marca} ${moto.modelo} Placas: ${moto.placas}`);
    res.status(201).json(moto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: ÓRDENES DE SERVICIO
// ==========================================

app.get('/api/ordenes', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.ordenServicio.findMany({
      include: { cliente: true, motocicleta: true, tecnico: true, refacciones: true }
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ordenes', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  const { refacciones, ...orderData } = req.body;
  try {
    // 1. Generar Folio consecutivo automático
    const totalCount = await prisma.ordenServicio.count();
    const currentYear = new Date().getFullYear();
    const folio = `OS-${currentYear}-${String(totalCount + 1).padStart(4, '0')}`;

    // 2. Transacción de creación y descuento de inventario
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.ordenServicio.create({
        data: { ...orderData, folio }
      });

      // Si incluye refacciones consumidas de inicio
      if (refacciones && refacciones.length > 0) {
        for (const item of refacciones) {
          // Descontar existencias
          await tx.refaccion.update({
            where: { id: item.refaccionId },
            data: { existencia: { decrement: item.cantidad } }
          });
          // Vincular a orden
          await tx.ordenRefaccion.create({
            data: {
              ordenId: order.id,
              refaccionId: item.refaccionId,
              cantidad: item.cantidad,
              precioUnitario: item.precioUnitario
            }
          });
        }
      }
      return order;
    });

    await logAudit(req.user.id, 'CREATE', 'ordenes_servicio', result.id, `Apertura de orden: ${result.folio}`);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: GARANTÍAS
// ==========================================

app.get('/api/garantias', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.garantia.findMany({
      include: { cliente: true, motocicleta: true, orden: true }
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/garantias', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  try {
    const count = await prisma.garantia.count();
    const currentYear = new Date().getFullYear();
    const numeroGarantia = `GAR-${currentYear}-${String(count + 1).padStart(4, '0')}`;

    const warranty = await prisma.garantia.create({
      data: { ...req.body, numeroGarantia }
    });

    await logAudit(req.user.id, 'CREATE', 'garantias', warranty.id, `Apertura de garantía: ${numeroGarantia}`);
    res.status(201).json(warranty);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: INVENTARIO / REFACCIONES
// ==========================================

app.get('/api/refacciones', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.refaccion.findMany();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/refacciones/:id/ajustar', authenticateToken, checkRole(['ADMINISTRADOR', 'ALMACEN']), async (req, res) => {
  const { id } = req.params;
  const { cantidad, tipo, motivo } = req.body; // tipo: ENTRADA, SALIDA
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const ref = await tx.refaccion.update({
        where: { id },
        data: {
          existencia: tipo === 'ENTRADA' ? { increment: cantidad } : { decrement: cantidad }
        }
      });

      await tx.movimientoInventario.create({
        data: {
          refaccionId: id,
          tipo,
          cantidad,
          motivo,
          usuarioId: req.user.id
        }
      });
      return ref;
    });

    await logAudit(req.user.id, 'UPDATE', 'refacciones', id, `Ajuste Kardex (${tipo}): ${updated.codigo} - Cantidad: ${cantidad}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: COTIZACIONES
// ==========================================

app.get('/api/cotizaciones', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.cotizacion.findMany({
      include: { cotizacionItems: true, cliente: true },
      orderBy: { creadoEn: 'desc' }
    });
    // Formatear tipos Decimal a Number
    const formatted = data.map(c => ({
      ...c,
      costoServicio: Number(c.costoServicio),
      costoRefacciones: Number(c.costoRefacciones),
      costoTotal: Number(c.costoTotal),
      cotizacionItems: c.cotizacionItems.map(item => ({
        ...item,
        costo: Number(item.costo),
        manoDeObra: Number(item.manoDeObra)
      }))
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cotizaciones', authenticateToken, checkRole(['ADMINISTRADOR', 'GERENCIA']), async (req, res) => {
  const { cotizacionItems, registrarNuevo, nuevoCliente, ...cotData } = req.body;
  try {
    const result = await prisma.$transaction(async (tx) => {
      let clienteId = cotData.clienteId;

      if (registrarNuevo && nuevoCliente) {
        const nc = await tx.cliente.create({ data: nuevoCliente });
        clienteId = nc.id;
      }

      const count = await tx.cotizacion.count();
      const currentYear = new Date().getFullYear();
      const folio = `COT-${currentYear}-${String(count + 1).padStart(4, '0')}`;

      const cotizacion = await tx.cotizacion.create({
        data: {
          ...cotData,
          clienteId,
          folio,
          cotizacionItems: {
            create: cotizacionItems || []
          }
        },
        include: { cotizacionItems: true }
      });

      return cotizacion;
    });

    await logAudit(req.user.id, 'CREATE', 'cotizaciones', result.id, `Creación de cotización: ${result.folio}`);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cotizaciones/:id', authenticateToken, checkRole(['ADMINISTRADOR', 'GERENCIA']), async (req, res) => {
  const { id } = req.params;
  const { cotizacionItems, ...cotData } = req.body;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.cotizacionItem.deleteMany({ where: { cotizacionId: id } });

      const cot = await tx.cotizacion.update({
        where: { id },
        data: {
          ...cotData,
          cotizacionItems: {
            create: cotizacionItems || []
          }
        },
        include: { cotizacionItems: true }
      });

      return cot;
    });

    await logAudit(req.user.id, 'UPDATE', 'cotizaciones', id, `Modificación de cotización: ${updated.folio}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cotizaciones/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.cotizacion.delete({ where: { id } });
    await logAudit(req.user.id, 'DELETE', 'cotizaciones', id, `Eliminación cotización ID: ${id}`);
    res.json({ message: 'Cotización eliminada correctamente.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: TÉCNICOS
// ==========================================

// Helper para sincronizar automáticamente usuarios de rol 'TECNICO' hacia el catálogo de técnicos
const syncTechnicians = async () => {
  try {
    const tecnicoRol = await prisma.rol.findFirst({
      where: { nombre: 'TECNICO' }
    });
    if (!tecnicoRol) return;

    const techUsers = await prisma.usuario.findMany({
      where: { rolId: tecnicoRol.id }
    });

    for (const user of techUsers) {
      const exists = await prisma.tecnico.findUnique({
        where: { id: user.id }
      });
      if (!exists) {
        const existsByEmail = await prisma.tecnico.findFirst({
          where: { correo: user.email }
        });
        if (!existsByEmail) {
          await prisma.tecnico.create({
            data: {
              id: user.id,
              nombre: user.nombre,
              especialidad: 'General (Usuario CRM)',
              telefono: 'N/A',
              correo: user.email,
              activo: user.activo
            }
          });
        }
      } else {
        await prisma.tecnico.update({
          where: { id: user.id },
          data: {
            nombre: user.nombre,
            correo: user.email,
            activo: user.activo
          }
        });
      }
    }
  } catch (err) {
    console.error('Error en syncTechnicians:', err);
  }
};

app.get('/api/tecnicos', authenticateToken, async (req, res) => {
  try {
    await syncTechnicians();
    const data = await prisma.tecnico.findMany({
      orderBy: { nombre: 'asc' }
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tecnicos', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  try {
    const tech = await prisma.tecnico.create({ data: req.body });
    await logAudit(req.user.id, 'CREATE', 'tecnicos', tech.id, `Registro técnico: ${tech.nombre}`);
    res.status(201).json(tech);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tecnicos/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await prisma.tecnico.update({
      where: { id },
      data: req.body
    });
    await logAudit(req.user.id, 'UPDATE', 'tecnicos', id, `Modificación técnico: ${updated.nombre}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tecnicos/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.tecnico.delete({ where: { id } });
    await logAudit(req.user.id, 'DELETE', 'tecnicos', id, `Eliminación de técnico ID: ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ==========================================
// API REST: AUDITORÍA
// ==========================================

app.get('/api/auditorias', authenticateToken, checkRole(['ADMINISTRADOR', 'GERENCIA']), async (req, res) => {
  try {
    const data = await prisma.auditoria.findMany({
      include: { usuario: true },
      orderBy: { fecha: 'desc' },
      take: 200
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// API REST: ROLES Y GESTIÓN DE USUARIOS
// ==========================================

app.get('/api/roles', authenticateToken, async (req, res) => {
  try {
    const roles = await prisma.rol.findMany({
      orderBy: { nombre: 'asc' }
    });
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/usuarios', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  try {
    const users = await prisma.usuario.findMany({
      include: { rol: true },
      orderBy: { nombre: 'asc' }
    });
    // Omitir passwordHash
    const safeUsers = users.map(u => {
      const { passwordHash, ...rest } = u;
      return rest;
    });
    res.json(safeUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usuarios', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { nombre, email, password, rolId, sucursal, activo } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password || '123456', 10);
    const newUser = await prisma.usuario.create({
      data: {
        nombre,
        email,
        passwordHash,
        rolId,
        sucursal: sucursal || 'Sucursal Norte (Principal)',
        activo: activo !== undefined ? activo : true
      },
      include: { rol: true }
    });
    const { passwordHash: _, ...safeUser } = newUser;
    await logAudit(req.user.id, 'CREATE', 'usuarios', newUser.id, `Usuario creado: ${newUser.email} (${newUser.rol.nombre})`);
    
    await syncTechnicians();

    res.status(201).json(safeUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/usuarios/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  const { nombre, email, password, rolId, sucursal, activo } = req.body;
  try {
    const updateData = {
      nombre,
      email,
      rolId,
      sucursal,
      activo: activo !== undefined ? activo : true
    };
    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }
    const updated = await prisma.usuario.update({
      where: { id },
      data: updateData,
      include: { rol: true }
    });
    const { passwordHash: _, ...safeUser } = updated;
    await logAudit(req.user.id, 'UPDATE', 'usuarios', id, `Usuario actualizado: ${updated.email}`);
    
    await syncTechnicians();

    res.json(safeUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/usuarios/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    if (id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario.' });
    }
    const deleted = await prisma.usuario.delete({
      where: { id }
    });
    await logAudit(req.user.id, 'DELETE', 'usuarios', id, `Usuario eliminado: ${deleted.email}`);
    
    // Desactivar el técnico correspondiente para no romper llaves foráneas en órdenes de servicio
    await prisma.tecnico.updateMany({
      where: { id },
      data: { activo: false }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// INICIO DEL SERVIDOR DE PRODUCCIÓN
// ==========================================

app.listen(PORT, () => {
  console.log(`🚀 Servidor CRM de Motocicletas corriendo en http://localhost:${PORT}`);
});
