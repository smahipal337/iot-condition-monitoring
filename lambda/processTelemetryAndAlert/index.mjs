import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const sns = new SNSClient({});

const TABLE_NAME = process.env.TABLE_NAME || "EngineTelemetry";
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

// Vibration alerting runs on NET vibration in m/s²: the magnitude of the
// accelerometer vector with gravity removed. The MPU-6050 is mounted so that
// gravity sits almost entirely on the x axis, so a motionless machine still
// reads about 9.6 m/s² of raw magnitude; that nets out to roughly 0.2 m/s².
// Comparing the raw magnitude to a small threshold would alert on every
// reading, so gravity is removed first.
//
// 2.5 m/s² is provisional: roughly ten times the resting noise measured on
// site. Re-calibrate it against the machine's own running baseline once a
// full production cycle has been recorded.
const VIBRATION_THRESHOLD = parseFloat(process.env.VIBRATION_THRESHOLD || "2.5");
const GRAVITY_MS2 = parseFloat(process.env.GRAVITY_MS2 || "9.81");

const TEMP_MAX_C = parseFloat(process.env.TEMP_MAX_C || "35");
const TEMP_MIN_C = parseFloat(process.env.TEMP_MIN_C || "-5");
const TEMP_CALIBRATION_OFFSET_C = parseFloat(process.env.TEMP_CALIBRATION_OFFSET_C || "0");

export const handler = async (event) => {
  console.log("Incoming telemetry:", JSON.stringify(event));

  const {
    device_id,
    timestamp,
    humidity,
    vibration_x,
    vibration_y,
    vibration_z,
  } = event;

  // Sensor calibration: the ESP32's DHT22 reads ~3C higher than the factory's
  // reference thermometer (verified on-site). Corrected here so DynamoDB,
  // threshold alerting, and Grafana all reflect the true temperature.
  const temperature = event.temperature + TEMP_CALIBRATION_OFFSET_C;

  // Net vibration: how far total acceleration deviates from gravity alone.
  const axesPresent =
    Number.isFinite(vibration_x) &&
    Number.isFinite(vibration_y) &&
    Number.isFinite(vibration_z);

  let vibrationNet = null;
  if (axesPresent) {
    const magnitude = Math.sqrt(
      vibration_x * vibration_x +
        vibration_y * vibration_y +
        vibration_z * vibration_z
    );
    vibrationNet = Math.abs(magnitude - GRAVITY_MS2);
  } else {
    console.warn("Vibration axes missing or non-numeric; skipping vibration check.");
  }

  // The IoT rule also forwards vibration_intensity when the firmware publishes
  // it. The current sketch does not, so this is normally absent; when present
  // it is stored next to the value computed here so the two can be compared.
  // The alert below deliberately uses the locally computed, gravity-corrected
  // number, which does not depend on how the firmware defines intensity.
  const firmwareIntensity = Number.isFinite(event.vibration_intensity)
    ? event.vibration_intensity
    : null;

  // 1. Persist the reading in DynamoDB
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      device_id,
      timestamp,
      temperature,
      humidity,
      vibration_x,
      vibration_y,
      vibration_z,
      ...(vibrationNet !== null ? { vibration_net: vibrationNet } : {}),
      ...(firmwareIntensity !== null ? { vibration_intensity: firmwareIntensity } : {}),
    },
  }));

  // 2. Evaluate alert conditions
  const reasons = [];

  if (vibrationNet !== null && vibrationNet > VIBRATION_THRESHOLD) {
    reasons.push(
      `Abnormal vibration detected (net ${vibrationNet.toFixed(2)} m/s², threshold ${VIBRATION_THRESHOLD} m/s²)`
    );
  }
  if (temperature > TEMP_MAX_C) {
    reasons.push(`Temperature too high: ${temperature}°C (max ${TEMP_MAX_C}°C)`);
  }
  if (temperature < TEMP_MIN_C) {
    reasons.push(`Temperature too low: ${temperature}°C (min ${TEMP_MIN_C}°C)`);
  }

  // 3. Publish an alert if any threshold was breached
  if (reasons.length > 0 && SNS_TOPIC_ARN) {
    const message =
      `Device: ${device_id}\n` +
      `Time: ${new Date(timestamp).toISOString()}\n\n` +
      `Alert(s):\n- ${reasons.join("\n- ")}\n\n` +
      `Readings: temp=${temperature}°C, humidity=${humidity}%, ` +
      `net vibration=${vibrationNet === null ? "n/a" : vibrationNet.toFixed(2) + " m/s²"}, ` +
      `vibration=(${vibration_x}, ${vibration_y}, ${vibration_z})`;

    await sns.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: `Engine Alert: ${device_id}`,
      Message: message,
    }));

    console.log("Alert published to SNS:", reasons);
  }

  return {
    statusCode: 200,
    alerted: reasons.length > 0,
    reasons,
    vibration_net: vibrationNet,
  };
};
