// CRM DE SERVICIO Y GARANTÍAS - SERVIDOR BACKEND REST API DE PRODUCCIÓN
// Tecnologías: Node.js, Express, Prisma ORM, JWT, Postgres

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

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

    // 1. Obtener todos los clientes existentes en una sola consulta
    const existingClients = await prisma.cliente.findMany({
      select: { id: true, nombreCompleto: true, email: true }
    });

    // 2. Obtener todos los VINs existentes en una sola consulta
    const existingMotos = await prisma.motocicleta.findMany({
      select: { vin: true }
    });
    const existingVins = new Set(existingMotos.map(m => m.vin.toLowerCase().trim()));

    // Mapas en memoria para buscar duplicados rápidamente
    const clientMap = new Map();
    existingClients.forEach(c => {
      clientMap.set(c.nombreCompleto.toLowerCase().trim(), c.id);
      if (c.email) {
        clientMap.set(c.email.toLowerCase().trim(), c.id);
      }
    });

    const newClients = [];
    const newMotos = [];

    // Colección de clientes recién creados en este lote (para asociar a motos del mismo lote)
    const tempClientMap = new Map();

    for (const row of records) {
      const { nombreCompleto, email, telefono, moto } = row;
      if (!nombreCompleto || !moto || !moto.vin) continue;

      const normName = nombreCompleto.toLowerCase().trim();
      const normEmail = email ? email.toLowerCase().trim() : null;
      const normVin = moto.vin.toLowerCase().trim();

      // Resolver Cliente
      let clienteId = clientMap.get(normName) || (normEmail ? clientMap.get(normEmail) : null);

      if (!clienteId) {
        // Verificar si ya lo creamos en este mismo lote
        clienteId = tempClientMap.get(normName) || (normEmail ? tempClientMap.get(normEmail) : null);
        
        if (!clienteId) {
          // Generar nuevo UUID para el cliente
          clienteId = crypto.randomUUID();
          
          newClients.push({
            id: clienteId,
            nombreCompleto: nombreCompleto.trim(),
            email: email ? email.trim() : null,
            telefono: telefono || 'N/A'
          });
          
          tempClientMap.set(normName, clienteId);
          if (normEmail) {
            tempClientMap.set(normEmail, clienteId);
          }
          clientesCreados++;
        }
      }

      // Resolver Motocicleta
      if (existingVins.has(normVin)) {
        skippedMotos++;
        continue;
      }

      // Verificar que no hayamos agregado este mismo VIN en este lote
      const alreadyAddedVin = newMotos.some(m => m.vin.toLowerCase().trim() === normVin);
      if (alreadyAddedVin) {
        skippedMotos++;
        continue;
      }

      const fechaCompra = new Date();
      const fechaGarantiaLimite = new Date();
      fechaGarantiaLimite.setFullYear(fechaGarantiaLimite.getFullYear() + 2);

      newMotos.push({
        id: crypto.randomUUID(), // Generamos ID para la moto también
        clienteId,
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
      });
      motosCreadas++;
    }

    // 3. Ejecutar inserción en lote (Bulk Insert) en una sola transacción ultrarrápida
    if (newClients.length > 0 || newMotos.length > 0) {
      await prisma.$transaction([
        ...(newClients.length > 0 ? [prisma.cliente.createMany({ data: newClients })] : []),
        ...(newMotos.length > 0 ? [prisma.motocicleta.createMany({ data: newMotos })] : [])
      ]);
    }

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
    const data = { ...req.body };
    if (!data.vin?.trim()) {
      data.vin = 'S/N-' + Math.random().toString(36).substring(2, 11).toUpperCase();
    } else {
      data.vin = data.vin.trim().toUpperCase();
    }
    
    const fechaCompraObj = data.fechaCompra ? new Date(data.fechaCompra) : new Date();
    data.fechaCompra = fechaCompraObj;
    
    const limiteGarantia = new Date(fechaCompraObj);
    limiteGarantia.setFullYear(limiteGarantia.getFullYear() + 2);
    data.fechaGarantiaLimite = limiteGarantia;

    const moto = await prisma.motocicleta.create({ data });
    await logAudit(req.user.id, 'CREATE', 'motocicletas', moto.id, `Ingreso de moto: ${moto.marca} ${moto.modelo} Placas: ${moto.placas}`);
    res.status(201).json(moto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/motocicletas/:id', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION']), async (req, res) => {
  const { id } = req.params;
  try {
    const data = { ...req.body };
    if (!data.vin?.trim()) {
      data.vin = 'S/N-' + Math.random().toString(36).substring(2, 11).toUpperCase();
    } else {
      data.vin = data.vin.trim().toUpperCase();
    }
    
    const fechaCompraObj = data.fechaCompra ? new Date(data.fechaCompra) : new Date();
    data.fechaCompra = fechaCompraObj;
    
    const limiteGarantia = new Date(fechaCompraObj);
    limiteGarantia.setFullYear(limiteGarantia.getFullYear() + 2);
    data.fechaGarantiaLimite = limiteGarantia;

    const updated = await prisma.motocicleta.update({
      where: { id },
      data
    });
    await logAudit(req.user.id, 'UPDATE', 'motocicletas', id, `Modificación moto: ${updated.marca} ${updated.modelo} Placas: ${updated.placas}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/motocicletas/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.motocicleta.delete({ where: { id } });
    await logAudit(req.user.id, 'DELETE', 'motocicletas', id, `Eliminación de moto ID: ${id}`);
    res.json({ message: 'Motocicleta eliminada correctamente.' });
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
    const parsed = data.map(o => ({
      ...o,
      cotizacionItems: o.cotizacionItems ? JSON.parse(o.cotizacionItems) : []
    }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper para limpiar campos adicionales no soportados por Prisma en OrdenServicio
const filterOrdenData = (body) => {
  const data = {};
  
  if (body.clienteId !== undefined) data.clienteId = body.clienteId;
  if (body.motocicletaId !== undefined) data.motocicletaId = body.motocicletaId;
  if (body.tecnicoId !== undefined) data.tecnicoId = body.tecnicoId;
  if (body.kilometraje !== undefined) data.kilometraje = parseInt(body.kilometraje, 10) || 0;
  if (body.tipoServicio !== undefined) data.tipoServicio = body.tipoServicio;
  if (body.descripcionFalla !== undefined) data.descripcionFalla = body.descripcionFalla;
  if (body.diagnosticoTecnico !== undefined) data.diagnosticoTecnico = body.diagnosticoTecnico;
  if (body.solucionAplicada !== undefined) data.solucionAplicada = body.solucionAplicada;
  if (body.firmaCliente !== undefined) data.firmaCliente = body.firmaCliente;
  if (body.fechaCompromiso !== undefined) data.fechaCompromiso = new Date(body.fechaCompromiso);
  if (body.fechaEntrega !== undefined) data.fechaEntrega = body.fechaEntrega ? new Date(body.fechaEntrega) : null;
  if (body.estado !== undefined) data.estado = body.estado;
  if (body.costoTotal !== undefined) data.costoTotal = parseFloat(body.costoTotal) || 0;
  if (body.cotizacionVehiculo !== undefined) data.cotizacionVehiculo = body.cotizacionVehiculo;
  if (body.cotizacionItems !== undefined) {
    data.cotizacionItems = typeof body.cotizacionItems === 'string'
      ? body.cotizacionItems
      : JSON.stringify(body.cotizacionItems);
  }

  return data;
};

app.post('/api/ordenes', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION', 'TECNICO']), async (req, res) => {
  const { refacciones, refaccionesUtilizadas, registrarNuevo, nuevoCliente, registrarNuevaMotoParaClienteExistente, nuevaMoto, ...rawBody } = req.body;
  try {
    const result = await prisma.$transaction(async (tx) => {
      let clienteId = rawBody.clienteId;
      let motocicletaId = rawBody.motocicletaId;

      // 1. Registrar Cliente Nuevo al vuelo si aplica
      if (registrarNuevo && nuevoCliente) {
        const nc = await tx.cliente.create({
          data: {
            nombreCompleto: nuevoCliente.nombreCompleto,
            telefono: nuevoCliente.telefono,
            email: nuevoCliente.email || '',
            direccion: nuevoCliente.direccion || '',
            rfc: nuevoCliente.rfc || ''
          }
        });
        clienteId = nc.id;
      }

      // 2. Registrar Motocicleta Nueva al vuelo si aplica
      if ((registrarNuevo || registrarNuevaMotoParaClienteExistente) && nuevaMoto) {
        const targetVin = nuevaMoto.vin?.trim() ? nuevaMoto.vin.trim().toUpperCase() : ('S/N-' + Math.random().toString(36).substring(2, 11).toUpperCase());
        
        if (nuevaMoto.vin?.trim()) {
          const existingMoto = await tx.motocicleta.findUnique({
            where: { vin: targetVin }
          });
          if (existingMoto) {
            throw new Error(`La motocicleta con número de serie (VIN) ${nuevaMoto.vin} ya se encuentra registrada en el sistema.`);
          }
        }

        const nm = await tx.motocicleta.create({
          data: {
            clienteId: clienteId,
            marca: nuevaMoto.marca || 'VENTO',
            modelo: nuevaMoto.modelo,
            anio: parseInt(nuevaMoto.anio, 10) || new Date().getFullYear(),
            vin: targetVin,
            numeroMotor: nuevaMoto.numeroMotor || 'N/A',
            placas: nuevaMoto.placas || '',
            color: nuevaMoto.color || 'N/A',
            kilometraje: parseInt(nuevaMoto.kilometraje, 10) || 0,
            fechaCompra: nuevaMoto.fechaCompra ? new Date(nuevaMoto.fechaCompra) : new Date(),
            fechaGarantiaLimite: new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000)
          }
        });
        motocicletaId = nm.id;
      }

      // 3. Generar Folio consecutivo automático (robusto ante eliminaciones)
      const currentYear = new Date().getFullYear();
      const existingOrders = await tx.ordenServicio.findMany({
        where: {
          folio: {
            startsWith: `OS-${currentYear}-`
          }
        },
        select: {
          folio: true
        }
      });
      let maxNum = 0;
      existingOrders.forEach(o => {
        const parts = o.folio.split('-');
        if (parts.length === 3) {
          const num = parseInt(parts[2], 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      });
      const folio = `OS-${currentYear}-${String(maxNum + 1).padStart(4, '0')}`;

      // 4. Filtrar y preparar datos de la orden
      const orderData = filterOrdenData({
        ...rawBody,
        clienteId,
        motocicletaId
      });

      // 5. Crear la orden de servicio
      const order = await tx.ordenServicio.create({
        data: { ...orderData, folio }
      });

      // 6. Descontar stock y registrar refacciones reales
      const cleanRefacciones = (refacciones || refaccionesUtilizadas || []).filter(
        item => item.refaccionId && !item.refaccionId.startsWith('COT-ITEM')
      );

      if (cleanRefacciones.length > 0) {
        for (const item of cleanRefacciones) {
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
              precioUnitario: parseFloat(item.precioUnitario) || 0
            }
          });
        }
      }

      return order;
    });

    await logAudit(req.user.id, 'CREATE', 'ordenes_servicio', result.id, `Apertura de orden: ${result.folio}`);
    const responseData = {
      ...result,
      cotizacionItems: result.cotizacionItems ? JSON.parse(result.cotizacionItems) : []
    };
    res.status(201).json(responseData);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/ordenes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { refacciones, refaccionesUtilizadas, ...rawBody } = req.body;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Filtrar y preparar datos de la orden
      const orderData = filterOrdenData(rawBody);

      // 2. Actualizar la orden de servicio
      const order = await tx.ordenServicio.update({
        where: { id },
        data: orderData
      });

      // 3. Vincular refacciones si aplica
      const cleanRefacciones = (refacciones || refaccionesUtilizadas || []).filter(
        item => item.refaccionId && !item.refaccionId.startsWith('COT-ITEM')
      );

      if (cleanRefacciones.length > 0) {
        await tx.ordenRefaccion.deleteMany({ where: { ordenId: id } });

        for (const item of cleanRefacciones) {
          await tx.ordenRefaccion.create({
            data: {
              ordenId: id,
              refaccionId: item.refaccionId,
              cantidad: item.cantidad,
              precioUnitario: parseFloat(item.precioUnitario) || 0
            }
          });
        }
      }

      return order;
    });

    await logAudit(req.user.id, 'UPDATE', 'ordenes_servicio', id, `Modificación de orden: ${result.folio}`);
    const responseData = {
      ...result,
      cotizacionItems: result.cotizacionItems ? JSON.parse(result.cotizacionItems) : []
    };
    res.json(responseData);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/ordenes/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await prisma.ordenServicio.delete({
      where: { id }
    });
    await logAudit(req.user.id, 'DELETE', 'ordenes_servicio', id, `Eliminación de orden de servicio folio: ${deleted.folio}`);
    res.json({ success: true });
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

app.post('/api/cotizaciones', authenticateToken, checkRole(['ADMINISTRADOR', 'GERENCIA', 'TECNICO']), async (req, res) => {
  const { cotizacionItems, registrarNuevo, nuevoCliente, ...cotData } = req.body;
  try {
    const result = await prisma.$transaction(async (tx) => {
      let clienteId = cotData.clienteId;

      if (registrarNuevo && nuevoCliente) {
        const nc = await tx.cliente.create({ data: nuevoCliente });
        clienteId = nc.id;
      }

      // Generar Folio consecutivo automático (robusto ante eliminaciones)
      const currentYear = new Date().getFullYear();
      const existingCots = await tx.cotizacion.findMany({
        where: {
          folio: {
            startsWith: `COT-${currentYear}-`
          }
        },
        select: {
          folio: true
        }
      });
      let maxNum = 0;
      existingCots.forEach(c => {
        const parts = c.folio.split('-');
        if (parts.length === 3) {
          const num = parseInt(parts[2], 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      });
      const folio = `COT-${currentYear}-${String(maxNum + 1).padStart(4, '0')}`;
      const fecha = cotData.fecha || new Date().toISOString().split('T')[0];

      const cotizacion = await tx.cotizacion.create({
        data: {
          ...cotData,
          clienteId,
          folio,
          fecha,
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

app.put('/api/cotizaciones/:id', authenticateToken, checkRole(['ADMINISTRADOR', 'GERENCIA', 'TECNICO']), async (req, res) => {
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
    const data = { ...req.body };
    if (data.fechaIngreso) {
      data.fechaIngreso = new Date(data.fechaIngreso);
    }
    const tech = await prisma.tecnico.create({ data });
    await logAudit(req.user.id, 'CREATE', 'tecnicos', tech.id, `Registro técnico: ${tech.nombre}`);
    res.status(201).json(tech);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/tecnicos/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    const data = { ...req.body };
    if (data.fechaIngreso) {
      data.fechaIngreso = new Date(data.fechaIngreso);
    }
    const updated = await prisma.tecnico.update({
      where: { id },
      data
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
    // 1. Intentar eliminación física de la base de datos
    await prisma.tecnico.delete({ where: { id } });
    await logAudit(req.user.id, 'DELETE', 'tecnicos', id, `Eliminación física de técnico ID: ${id}`);
    res.json({ success: true, message: 'Técnico eliminado de la base de datos.' });
  } catch (err) {
    // 2. Si falla por llave foránea debido a órdenes asignadas (código P2003 de Prisma o texto relacionado)
    if (err.code === 'P2003' || err.message.includes('foreign key constraint') || err.message.includes('violates RESTRICT')) {
      try {
        const updated = await prisma.tecnico.update({
          where: { id },
          data: { activo: false }
        });
        await logAudit(req.user.id, 'DISABLE', 'tecnicos', id, `Baja lógica (inactivo) de técnico ID: ${id} debido a dependencias.`);
        return res.json({ 
          success: true, 
          message: 'El técnico tiene órdenes asociadas. Se ha cambiado su estado a INACTIVO para preservar el historial.',
          softDeleted: true
        });
      } catch (subErr) {
        return res.status(400).json({ error: subErr.message });
      }
    }
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// API REST: ACTIVACIONES DE UNIDAD
// ==========================================

app.get('/api/activaciones', authenticateToken, async (req, res) => {
  try {
    const data = await prisma.activacion.findMany({
      orderBy: { fecha: 'desc' }
    });
    // Formatear la fecha como string YYYY-MM-DD
    const formatted = data.map(act => ({
      ...act,
      fecha: act.fecha.toISOString().split('T')[0]
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/activaciones', authenticateToken, checkRole(['ADMINISTRADOR', 'RECEPCION', 'TECNICO']), async (req, res) => {
  const { vin } = req.body;
  try {
    // Verificar si ya está activado ese VIN
    const existing = await prisma.activacion.findUnique({
      where: { vin: vin.trim().toUpperCase() }
    });
    if (existing) {
      return res.status(400).json({ error: `La unidad con VIN ${vin} ya ha sido activada anteriormente.` });
    }

    const count = await prisma.activacion.count();
    const formattedId = `ACT-${String(count + 1).padStart(2, '0')}`;

    const activacion = await prisma.activacion.create({
      data: {
        ...req.body,
        id: formattedId,
        vin: vin.trim().toUpperCase()
      }
    });

    await logAudit(req.user.id, 'CREATE', 'activaciones', activacion.id, `Activación de unidad: Marca ${activacion.marca}, Modelo ${activacion.modelo}, Tienda ${activacion.tienda}`);
    res.status(201).json(activacion);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/activaciones/:id', authenticateToken, checkRole(['ADMINISTRADOR']), async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await prisma.activacion.delete({
      where: { id }
    });
    await logAudit(req.user.id, 'DELETE', 'activaciones', id, `Eliminación de activación ID: ${id} (${deleted.marca} ${deleted.modelo})`);
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
    const deleted = await prisma.$transaction(async (tx) => {
      // 1. Eliminar los logs de auditoría asociados al usuario
      await tx.auditoria.deleteMany({
        where: { usuarioId: id }
      });

      // 2. Eliminar los movimientos de inventario asociados al usuario
      await tx.movimientoInventario.deleteMany({
        where: { usuarioId: id }
      });

      // 3. Eliminar el usuario
      return await tx.usuario.delete({
        where: { id }
      });
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
