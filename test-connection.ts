/**
 * Standalone test script to validate UDP communication with an OmniLogic controller.
 *
 * Usage:
 *   npx ts-node test-connection.ts <controller-ip>
 *   -- or --
 *   Create a .env file with OMNILOGIC_HOST=192.168.1.xxx and run:
 *   npx ts-node test-connection.ts
 *
 * Tests:
 *   1. Fetch MSPConfig and list discovered groups/themes, bodies of water, and lights
 *   2. Fetch telemetry and show group states (ON/OFF), water temperatures, and light states
 *   3. Optionally toggle a group (uncomment the section below)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { OmniLogicClient } from './src/omnilogic/client';
import { parseGroups, parseBodiesOfWater, parseLights, parseGroupTelemetry, parseBodyOfWaterTelemetry, parseLightTelemetry } from './src/omnilogic/xml';
import { SHOW_DATA } from './src/lightAccessory';

const BRIGHTNESS_LABELS: Record<number, string> = { 0: '20%', 1: '40%', 2: '60%', 3: '80%', 4: '100%' };
const SPEED_LABELS: Record<number, string> = { 0: '1/16x', 1: '1/8x', 2: '1/4x', 3: '1/2x', 4: '1x', 5: '2x', 6: '4x', 7: '8x', 8: '16x' };

// Load .env if present
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const host = process.argv[2] || process.env.OMNILOGIC_HOST;
if (!host) {
  console.error('Usage: npx ts-node test-connection.ts <controller-ip>');
  console.error('  Or set OMNILOGIC_HOST in a .env file');
  process.exit(1);
}

async function main() {
  const client = new OmniLogicClient(host!);

  try {
    // Test 1: Discover all accessories from MSPConfig
    console.log(`\nConnecting to OmniLogic controller at ${host}...`);
    console.log('Fetching MSPConfig...\n');
    const configXml = await client.getConfig();

    const groups = parseGroups(configXml);
    console.log(`Found ${groups.length} group(s)/theme(s):`);
    for (const g of groups) {
      console.log(`  - [${g.systemId}] ${g.name}`);
    }

    const bodies = parseBodiesOfWater(configXml);
    console.log(`\nFound ${bodies.length} body/bodies of water:`);
    for (const b of bodies) {
      console.log(`  - [${b.systemId}] ${b.name}`);
    }

    const lights = parseLights(configXml);
    console.log(`\nFound ${lights.length} light(s):`);
    for (const l of lights) {
      console.log(`  - [${l.systemId}] ${l.name} (BOW: ${l.bowSystemId})`);
    }

    // Test 2: Get telemetry
    console.log('\nFetching telemetry...\n');
    const telemetryXml = await client.getTelemetry();

    const states = parseGroupTelemetry(telemetryXml);
    console.log('Group states:');
    for (const s of states) {
      const group = groups.find(g => g.systemId === s.systemId);
      const name = group?.name ?? `Unknown(${s.systemId})`;
      console.log(`  - [${s.systemId}] ${name}: ${s.state === 1 ? 'ON' : 'OFF'}`);
    }

    const bodyTemps = parseBodyOfWaterTelemetry(telemetryXml);
    console.log('\nWater temperatures:');
    for (const bt of bodyTemps) {
      const body = bodies.find(b => b.systemId === bt.systemId);
      const name = body?.name ?? `Unknown(${bt.systemId})`;
      const tempF = bt.waterTemp;
      const tempC = tempF === -1 ? 'N/A' : `${((tempF - 32) * 5 / 9).toFixed(1)}°C`;
      console.log(`  - [${bt.systemId}] ${name}: ${tempF}°F (${tempC})`);
    }

    const lightStates = parseLightTelemetry(telemetryXml);
    console.log('\nLight states:');
    for (const ls of lightStates) {
      const light = lights.find(l => l.systemId === ls.systemId);
      const name = light?.name ?? `Unknown(${ls.systemId})`;
      const on = ls.lightState !== 0;
      const showName = SHOW_DATA[ls.currentShow]?.name ?? `Unknown(${ls.currentShow})`;
      const brightness = BRIGHTNESS_LABELS[ls.brightness] ?? `${ls.brightness}`;
      const speed = SPEED_LABELS[ls.speed] ?? `${ls.speed}`;
      console.log(`  - [${ls.systemId}] ${name}: ${on ? 'ON' : 'OFF'} (lightState=${ls.lightState}, show=${ls.currentShow} "${showName}", brightness=${brightness}, speed=${speed})`);
    }

    // Test 3: Toggle a group (uncomment to test)
    // const testGroupId = groups[0]?.systemId;
    // if (testGroupId) {
    //   console.log(`\nToggling group ${testGroupId} ON...`);
    //   await client.setGroupState(testGroupId, true);
    //   console.log('Command sent. Check your pool equipment!');
    // }

    console.log('\nAll tests passed!');
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  } finally {
    client.close();
    // Force exit since the UDP socket may keep the process alive briefly
    setTimeout(() => process.exit(0), 500);
  }
}

main();
