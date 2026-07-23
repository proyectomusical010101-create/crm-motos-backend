import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function runBackup() {
  console.log('--- Iniciando Respaldo de Base de Datos ---');
  try {
    const backupData = {
      backupDate: new Date().toISOString(),
      systemVersion: '1.0.0',
      database: 'neondb',
      tables: {}
    };

    const models = [
      { name: 'roles', query: () => prisma.rol.findMany() },
      { name: 'usuarios', query: () => prisma.usuario.findMany() },
      { name: 'clientes', query: () => prisma.cliente.findMany() },
      { name: 'motocicletas', query: () => prisma.motocicleta.findMany() },
      { name: 'tecnicos', query: () => prisma.tecnico.findMany() },
      { name: 'refacciones', query: () => prisma.refaccion.findMany() },
      { name: 'ordenesServicio', query: () => prisma.ordenServicio.findMany() },
      { name: 'ordenesRefaccion', query: () => prisma.ordenRefaccion.findMany() },
      { name: 'garantias', query: () => prisma.garantia.findMany() },
      { name: 'movimientosInventario', query: () => prisma.movimientoInventario.findMany() },
      { name: 'fotografias', query: () => prisma.fotografia.findMany() },
      { name: 'auditorias', query: () => prisma.auditoria.findMany() },
      { name: 'cotizaciones', query: () => prisma.cotizacion.findMany() },
      { name: 'cotizacionesItems', query: () => prisma.cotizacionItem.findMany() },
      { name: 'activaciones', query: () => prisma.activacion.findMany() },
      { name: 'reparacionesSimples', query: () => prisma.reparacionSimple.findMany() }
    ];

    for (const model of models) {
      console.log(`Extrayendo datos de la tabla: ${model.name}...`);
      try {
        const data = await model.query();
        backupData.tables[model.name] = data;
        console.log(`✔ Extracción exitosa. Registros obtenidos: ${data.length}`);
      } catch (err) {
        console.error(`❌ Error al extraer tabla ${model.name}:`, err.message);
        backupData.tables[model.name] = { error: err.message };
      }
    }

    const today = new Date().toISOString().split('T')[0];
    const filename = `Respaldo_CRM_SR_MotoPartes_${today}.json`;
    
    let outputPath;
    if (fs.existsSync('C:\\Users\\apina\\Downloads')) {
      outputPath = path.join('C:\\Users\\apina\\Downloads', filename);
    } else {
      outputPath = path.join(process.cwd(), 'backups', filename);
    }

    const backupDir = path.dirname(outputPath);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    console.log(`Escribiendo archivo de respaldo en: ${outputPath}...`);
    fs.writeFileSync(outputPath, JSON.stringify(backupData, null, 2), 'utf-8');

    console.log('\n=========================================');
    console.log('✅ RESPALDO COMPLETADO CON ÉXITO');
    console.log('Archivo guardado en descargas:');
    console.log(outputPath);
    console.log('=========================================');

  } catch (err) {
    console.error('❌ Error crítico durante el respaldo:', err);
  } finally {
    await prisma.$disconnect();
  }
}

runBackup();
