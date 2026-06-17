import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Seed Roles
  const adminRol = await prisma.rol.upsert({
    where: { nombre: 'ADMINISTRADOR' },
    update: {},
    create: {
      nombre: 'ADMINISTRADOR',
      descripcion: 'Acceso total y configuración del sistema (Usuario Dios)'
    }
  });

  const tecnicoRol = await prisma.rol.upsert({
    where: { nombre: 'TECNICO' },
    update: {},
    create: {
      nombre: 'TECNICO',
      descripcion: 'Recepción, diagnóstico técnico, reparación, entrega e insumos de refacciones'
    }
  });

  const gerenciaRol = await prisma.rol.upsert({
    where: { nombre: 'GERENCIA' },
    update: {},
    create: {
      nombre: 'GERENCIA',
      descripcion: 'Visualización de reportes, KPIs ejecutivos y estadísticas'
    }
  });

  console.log('✅ Roles seeded successfully.');

  // Hash standard demo password: '123456'
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash('123456', salt);

  // 2. Seed Users
  const adminUser = await prisma.usuario.upsert({
    where: { email: 'admin@crmmotos.com' },
    update: {},
    create: {
      email: 'admin@crmmotos.com',
      nombre: 'Alejandro Pina',
      passwordHash: passwordHash,
      rolId: adminRol.id,
      sucursal: 'Sucursal Norte (Principal)',
      activo: true
    }
  });

  const tecnicoUser = await prisma.usuario.upsert({
    where: { email: 'tecnico1@crmmotos.com' },
    update: {},
    create: {
      email: 'tecnico1@crmmotos.com',
      nombre: 'Carlos Ortiz',
      passwordHash: passwordHash,
      rolId: tecnicoRol.id,
      sucursal: 'Sucursal Norte (Principal)',
      activo: true
    }
  });

  const gerenteUser = await prisma.usuario.upsert({
    where: { email: 'gerente@crmmotos.com' },
    update: {},
    create: {
      email: 'gerente@crmmotos.com',
      nombre: 'Martín Villanueva',
      passwordHash: passwordHash,
      rolId: gerenciaRol.id,
      sucursal: 'Sucursal Central',
      activo: true
    }
  });

  console.log('✅ Users seeded successfully.');

  // 3. Seed Personal Técnico
  const tecnicosData = [
    { nombre: 'Carlos Ortiz', especialidad: 'Motores y Transmisión (Certificado BAJAJ)', telefono: '5512345678', correo: 'carlos.ortiz@crmmotos.com' },
    { nombre: 'Juan Manuel Solís', especialidad: 'Sistemas Eléctricos y Fuel Injection', telefono: '5587654321', correo: 'juan.solis@crmmotos.com' },
    { nombre: 'Roberto González', especialidad: 'Ajuste de Chasis y Suspensión', telefono: '5599887766', correo: 'roberto.g@crmmotos.com' },
    { nombre: 'Luis Eduardo Lara', especialidad: 'Mantenimiento Preventivo General', telefono: '5544332211', correo: 'luis.lara@crmmotos.com' }
  ];

  for (const t of tecnicosData) {
    const exists = await prisma.tecnico.findFirst({
      where: { nombre: t.nombre }
    });
    if (!exists) {
      await prisma.tecnico.create({ data: t });
    }
  }

  console.log('✅ Technicians seeded successfully.');

  // 4. Seed Refacciones (Initial Inventory)
  const refaccionesData = [
    { codigo: 'B-PUL200-FIL', descripcion: 'Filtro de Aceite Bajaj Pulsar', marca: 'BAJAJ', categoria: 'Mantenimiento', ubicacion: 'Pasillo A - Estante 2', existencia: 45, stockMinimo: 10, costo: 85.00, precioVenta: 180.00, proveedor: 'Bajaj de México S.A.' },
    { codigo: 'B-DOM400-BLP', descripcion: 'Pastillas de Freno Delantero Orgánicas', marca: 'BAJAJ', categoria: 'Frenos', ubicacion: 'Pasillo A - Estante 4', existencia: 4, stockMinimo: 8, costo: 320.00, precioVenta: 680.00, proveedor: 'Bajaj de México S.A.' },
    { codigo: 'V-LITH150-CAR', descripcion: 'Carburador Completo Vento Lithium', marca: 'VENTO', categoria: 'Combustión', ubicacion: 'Pasillo B - Estante 1', existencia: 3, stockMinimo: 2, costo: 450.00, precioVenta: 950.00, proveedor: 'Refacciones Vento S.A.' },
    { codigo: 'V-BOX150-CAD', descripcion: 'Cadena de Transmisión Reforzada 428H', marca: 'VELOCI MOTORS', categoria: 'Tracción', ubicacion: 'Pasillo C - Estante 3', existencia: 12, stockMinimo: 5, costo: 150.00, precioVenta: 350.00, proveedor: 'Veloci Importadora' },
    { codigo: 'MB-TEK250-MON', descripcion: 'Monoamortiguador Trasero Tekken', marca: 'MB MOTOS', categoria: 'Suspensión', ubicacion: 'Pasillo D - Estante 2', existencia: 1, stockMinimo: 2, costo: 1200.00, precioVenta: 2400.00, proveedor: 'MB Motos Refacciones' },
    { codigo: 'B-GEN-BUJ', descripcion: 'Bujía NGK Iridium CR9EIX', marca: 'OTRAS', categoria: 'Eléctrico', ubicacion: 'Pasillo A - Estante 1', existencia: 60, stockMinimo: 15, costo: 95.00, precioVenta: 210.00, proveedor: 'NGK Spark Plugs' }
  ];

  for (const r of refaccionesData) {
    const exists = await prisma.refaccion.findUnique({
      where: { codigo: r.codigo }
    });
    if (!exists) {
      await prisma.refaccion.create({ data: r });
    }
  }

  console.log('✅ Inventory refacciones seeded successfully.');
  console.log('🌱 Seeding process complete!');
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
