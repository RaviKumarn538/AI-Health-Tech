const MISSING = "Not documented in available records.";

function fieldValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "value")) {
    return fieldValue(value.value);
  }
  return value;
}

function text(value) {
  const resolved = fieldValue(value);
  if (resolved === null || resolved === undefined) return "";
  if (Array.isArray(resolved)) return resolved.map(text).filter(Boolean).join(", ");
  if (typeof resolved === "object") return "";
  const result = String(resolved).trim();
  if (!result || /^(?:null|undefined|n\/a|na|none|not detected|not available)$/i.test(result)) return "";
  return result;
}

function unique(values) {
  const seen = new Set();
  return values.map((value) => String(value || "").trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function list(value) {
  if (!Array.isArray(value)) return value ? [value] : [];
  return value;
}

function recordData(record) {
  return record?.extractedData && typeof record.extractedData === "object" ? record.extractedData : {};
}

function structuredData(record) {
  const data = recordData(record);
  return data.structuredData && typeof data.structuredData === "object" ? data.structuredData : {};
}

function recordDate(record) {
  const value = record?.verifiedAt || record?.approvedAt || record?.createdAt || record?.document?.createdAt;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function dateLabel(value) {
  if (!value) return MISSING;
  const date = value instanceof Date ? value : new Date(value);
  if (!date || Number.isNaN(date.getTime())) return MISSING;
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date);
}

function isoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

function medicationName(medication) {
  return text(medication?.name || medication?.genericName || medication?.generic_name);
}

function medicationSnapshot(medication) {
  const name = medicationName(medication);
  if (!name) return null;
  return {
    name,
    genericName: text(medication.genericName || medication.generic_name),
    dosage: text(medication.dosage),
    frequency: text(medication.frequency),
    route: text(medication.route),
    duration: text(medication.duration),
    instructions: text(medication.instructions),
  };
}

function medicationDisplay(medication) {
  const item = medicationSnapshot(medication);
  if (!item) return "";
  const details = [item.dosage, item.frequency, item.route, item.duration].filter(Boolean).join(" · ");
  return details ? `${item.name} — ${details}` : item.name;
}

function investigationName(investigation) {
  return text(investigation?.testName || investigation?.test_name || investigation?.panelName || investigation?.panel_name);
}

function investigationSnapshot(investigation) {
  const testName = investigationName(investigation);
  if (!testName) return null;
  return {
    testName,
    resultValue: text(investigation.resultValue ?? investigation.result_value),
    units: text(investigation.units),
    referenceRange: text(investigation.referenceRange ?? investigation.reference_range),
    status: text(investigation.status).toUpperCase() || "UNKNOWN",
    testDate: isoDate(investigation.testDate || investigation.test_date),
  };
}

function investigationDisplay(investigation) {
  const item = investigationSnapshot(investigation);
  if (!item) return "";
  const result = [item.resultValue, item.units].filter(Boolean).join(" ");
  const status = item.status && item.status !== "UNKNOWN" ? ` [${item.status}]` : "";
  return `${item.testName}${result ? ` — ${result}` : ""}${status}`;
}

function diagnosisList(record) {
  const data = recordData(record);
  const structured = structuredData(record);
  const values = [];
  values.push(...list(data.diagnosis).map(text));
  values.push(...list(structured.diagnosis).map((item) => text(item?.value ?? item)));
  return unique(values);
}

function observationList(record) {
  const data = recordData(record);
  const structured = structuredData(record);
  const observations = [];
  for (const item of [...list(data.observations), ...list(structured.observations)]) {
    if (typeof item === "string") {
      if (text(item)) observations.push(text(item));
      continue;
    }
    const label = text(item?.observation || item?.name || item?.type);
    const value = text(item?.value || item?.result);
    const combined = [label, value].filter(Boolean).join(": ");
    if (combined) observations.push(combined);
  }
  return unique(observations);
}

function complaintList(record) {
  const data = recordData(record);
  const structured = structuredData(record);
  return unique([
    ...list(data.complaints).map(text),
    ...list(data.symptoms).map(text),
    ...list(structured.complaints).map((item) => text(item?.value ?? item)),
    ...list(structured.symptoms).map((item) => text(item?.value ?? item)),
  ]);
}

function explicitNotes(record) {
  const data = recordData(record);
  const structured = structuredData(record);
  const followUp = structured.followUp || data.followUp || {};
  return [
    text(record.verificationNotes),
    text(data.verificationNotes),
    text(data.summary),
    text(data.aiSummary),
    text(followUp.interval),
    text(followUp.advice),
  ].filter(Boolean);
}

function normalizedMedicationKey(medication) {
  return medicationName(medication).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function medicationSignature(medication) {
  const item = medicationSnapshot(medication) || {};
  return [item.dosage, item.frequency, item.route, item.duration, item.instructions].map((value) => String(value || "").toLowerCase().trim()).join("|");
}

function normalizedInvestigationKey(investigation) {
  return investigationName(investigation).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedRecord(record, index) {
  const data = recordData(record);
  const structured = structuredData(record);
  const date = recordDate(record);
  const medications = list(data.medications).map(medicationSnapshot).filter(Boolean);
  const investigations = [...list(data.labResults), ...list(structured.investigations)]
    .map(investigationSnapshot)
    .filter(Boolean);
  const diagnoses = diagnosisList(record);
  const complaints = complaintList(record);
  const observations = observationList(record);
  const followUp = structured.followUp || data.followUp || {};
  const followUpText = [text(followUp.interval), text(followUp.advice)].filter(Boolean).join(" · ");
  const notes = explicitNotes(record);
  const id = String(record?._id || record?.document?._id || `record-${index + 1}`);
  return {
    id,
    documentId: record?.document?._id ? String(record.document._id) : record?.document ? String(record.document) : "",
    date: isoDate(date),
    dateLabel: dateLabel(date),
    recordType: String(record.recordType || record.document?.documentType || "CLINICAL_NOTE"),
    title: String(record.title || record.document?.originalFilename || "Clinical record"),
    diagnoses,
    complaints,
    medications,
    investigations,
    observations,
    followUp: followUpText,
    notes,
    verificationNotes: text(record.verificationNotes),
    version: Number(record.version || 1),
    sourceRecordId: id,
  };
}

function sourceFingerprint(records) {
  return records.map((record) => {
    const date = recordDate(record);
    return `${String(record?._id || record?.document?._id || "")}:${date ? date.toISOString() : ""}:${record?.updatedAt ? new Date(record.updatedAt).toISOString() : ""}`;
  }).sort().join("|");
}

function compareRecordChanges(previous, current) {
  const changes = [];
  const previousMeds = new Map(previous.medications.map((item) => [normalizedMedicationKey(item), item]));
  const currentMeds = new Map(current.medications.map((item) => [normalizedMedicationKey(item), item]));
  const addedMeds = [...currentMeds.entries()].filter(([key]) => !previousMeds.has(key)).map(([, item]) => medicationDisplay(item));
  if (addedMeds.length) changes.push(`Newly documented medication(s): ${addedMeds.join(", ")}.`);

  const omittedMeds = [...previousMeds.entries()].filter(([key]) => !currentMeds.has(key)).map(([, item]) => medicationDisplay(item));
  if (omittedMeds.length) changes.push(`Previously documented medication(s) not listed in this record: ${omittedMeds.join(", ")}.`);

  const dosageChanges = [];
  for (const [key, currentMedication] of currentMeds.entries()) {
    const previousMedication = previousMeds.get(key);
    if (previousMedication && medicationSignature(previousMedication) !== medicationSignature(currentMedication)) {
      dosageChanges.push(`${medicationDisplay(previousMedication)} → ${medicationDisplay(currentMedication)}`);
    }
  }
  if (dosageChanges.length) changes.push(`Documented medication detail difference: ${dosageChanges.join("; ")}.`);

  const previousDiagnoses = new Set(previous.diagnoses.map((item) => item.toLowerCase()));
  const newDiagnoses = current.diagnoses.filter((item) => !previousDiagnoses.has(item.toLowerCase()));
  if (newDiagnoses.length) changes.push(`Newly documented diagnosis/condition: ${newDiagnoses.join(", ")}.`);

  const previousInvestigations = new Set(previous.investigations.map((item) => normalizedInvestigationKey(item)));
  const newInvestigations = current.investigations.filter((item) => !previousInvestigations.has(normalizedInvestigationKey(item)));
  if (newInvestigations.length) changes.push(`New investigation documented: ${newInvestigations.map(investigationDisplay).join(", ")}.`);

  if (previous.followUp !== current.followUp && (previous.followUp || current.followUp)) {
    changes.push(`Follow-up documentation differs: ${previous.followUp || MISSING} → ${current.followUp || MISSING}.`);
  }
  return changes;
}

function recordEvidence(record) {
  const recordId = String(record?.id || "");
  const documentId = String(record?.documentId || "");
  return {
    recordId,
    documentId,
    title: record?.title || "Clinical record",
    recordType: record?.recordType || "CLINICAL_NOTE",
    date: record?.date || "",
    dateLabel: record?.dateLabel || MISSING,
    recordUrl: recordId && !recordId.startsWith("record-") ? `/records/${recordId}` : "",
    documentUrl: documentId ? `/review/${documentId}` : "",
  };
}

function compareRecordSections(previous, current) {
  const previousMeds = new Map(previous.medications.map((item) => [normalizedMedicationKey(item), item]));
  const currentMeds = new Map(current.medications.map((item) => [normalizedMedicationKey(item), item]));
  const medicationAdded = [...currentMeds.entries()]
    .filter(([key]) => !previousMeds.has(key))
    .map(([, item]) => medicationDisplay(item));
  const medicationNotListed = [...previousMeds.entries()]
    .filter(([key]) => !currentMeds.has(key))
    .map(([, item]) => medicationDisplay(item));
  const medicationChanged = [];
  const medicationContinued = [];
  for (const [key, currentMedication] of currentMeds.entries()) {
    const previousMedication = previousMeds.get(key);
    if (!previousMedication) continue;
    if (medicationSignature(previousMedication) === medicationSignature(currentMedication)) {
      medicationContinued.push(medicationDisplay(currentMedication));
    } else {
      medicationChanged.push(`${medicationDisplay(previousMedication)} → ${medicationDisplay(currentMedication)}`);
    }
  }

  const previousDiagnoses = new Set(previous.diagnoses.map((item) => item.toLowerCase()));
  const currentDiagnoses = new Set(current.diagnoses.map((item) => item.toLowerCase()));
  const diagnosisAdded = current.diagnoses.filter((item) => !previousDiagnoses.has(item.toLowerCase()));
  const diagnosisContinued = current.diagnoses.filter((item) => previousDiagnoses.has(item.toLowerCase()));
  const diagnosisNotListed = previous.diagnoses.filter((item) => !currentDiagnoses.has(item.toLowerCase()));

  const previousInvestigations = new Map(previous.investigations.map((item) => [normalizedInvestigationKey(item), item]));
  const currentInvestigations = new Map(current.investigations.map((item) => [normalizedInvestigationKey(item), item]));
  const investigationAdded = [...currentInvestigations.entries()]
    .filter(([key]) => !previousInvestigations.has(key))
    .map(([, item]) => investigationDisplay(item));
  const investigationContinued = [...currentInvestigations.entries()]
    .filter(([key]) => previousInvestigations.has(key))
    .map(([, item]) => investigationDisplay(item));
  const investigationNotListed = [...previousInvestigations.entries()]
    .filter(([key]) => !currentInvestigations.has(key))
    .map(([, item]) => investigationDisplay(item));

  return {
    medication: {
      added: medicationAdded.length ? medicationAdded : [MISSING],
      continued: medicationContinued.length ? medicationContinued : [MISSING],
      changed: medicationChanged.length ? medicationChanged : [MISSING],
      notListed: medicationNotListed.length ? medicationNotListed : [MISSING],
    },
    diagnosis: {
      previous: previous.diagnoses.length ? previous.diagnoses : [MISSING],
      current: current.diagnoses.length ? current.diagnoses : [MISSING],
      added: diagnosisAdded.length ? diagnosisAdded : [MISSING],
      continued: diagnosisContinued.length ? diagnosisContinued : [MISSING],
      notListed: diagnosisNotListed.length ? diagnosisNotListed : [MISSING],
    },
    investigation: {
      previous: previous.investigations.length ? previous.investigations.map(investigationDisplay) : [MISSING],
      current: current.investigations.length ? current.investigations.map(investigationDisplay) : [MISSING],
      added: investigationAdded.length ? investigationAdded : [MISSING],
      continued: investigationContinued.length ? investigationContinued : [MISSING],
      notListed: investigationNotListed.length ? investigationNotListed : [MISSING],
    },
  };
}

function buildPatientHistoryIntelligence(patient = {}, medicalRecords = [], soapNotes = []) {
  const records = medicalRecords
    .filter((record) => record?.doctorVerified !== false && record?.status !== "REJECTED")
    .map(normalizedRecord)
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const latest = records[records.length - 1] || null;
  const previous = records.length > 1 ? records[records.length - 2] : null;

  const diagnoses = unique(records.flatMap((record) => record.diagnoses));
  const complaints = unique(records.flatMap((record) => record.complaints));
  const observations = unique(records.flatMap((record) => record.observations));
  const documentedNotes = unique([
    ...records.flatMap((record) => record.notes),
    ...list(soapNotes).flatMap((note) => [text(note.subjective), text(note.objective), text(note.assessment), text(note.plan)]),
  ]);
  const medicationEntries = records.flatMap((record) => record.medications.map((medication) => ({ ...medication, dateLabel: record.dateLabel, recordId: record.id })));
  const medicationMap = new Map();
  for (const item of medicationEntries) {
    const key = normalizedMedicationKey(item);
    if (key && !medicationMap.has(key)) medicationMap.set(key, item);
  }
  const allMedications = [...medicationMap.values()];
  const currentMedications = latest?.medications || [];
  const firstMedicationRecord = new Map();
  records.forEach((record) => record.medications.forEach((medication) => {
    const key = normalizedMedicationKey(medication);
    if (key && !firstMedicationRecord.has(key)) firstMedicationRecord.set(key, record);
  }));
  const addedMedications = allMedications
    .filter((medication) => firstMedicationRecord.get(normalizedMedicationKey(medication))?.id !== records[0]?.id)
    .map((medication) => `First documented ${medication.dateLabel}: ${medicationDisplay(medication)}`);

  const discontinuations = [];
  for (const record of records) {
    const noteText = [...record.notes, record.verificationNotes].join(" ");
    if (!/\b(discontinu|stop(?:ped)?|cease|withdr(?:aw|ew))\w*\b/i.test(noteText)) continue;
    for (const medication of allMedications) {
      if (noteText.toLowerCase().includes(String(medication.name || "").toLowerCase())) {
        discontinuations.push(`${medication.name} — explicitly referenced in the ${record.dateLabel} record`);
      }
    }
  }

  const dosageChanges = [];
  for (let index = 1; index < records.length; index += 1) {
    const pairChanges = compareRecordChanges(records[index - 1], records[index]);
    pairChanges.filter((change) => /medication detail difference/i.test(change)).forEach((change) => dosageChanges.push(`${records[index].dateLabel}: ${change}`));
  }

  const explicitlyDiscontinuedNames = new Set(discontinuations.map((item) => String(item).split(" — explicitly referenced")[0].toLowerCase()));
  const medicationTimeline = allMedications.map((medication) => {
    const key = normalizedMedicationKey(medication);
    const occurrences = records.filter((record) => record.medications.some((item) => normalizedMedicationKey(item) === key));
    const first = occurrences[0] || null;
    const last = occurrences[occurrences.length - 1] || null;
    const explicitlyDiscontinued = explicitlyDiscontinuedNames.has(String(medication.name).toLowerCase());
    let status = "First documented";
    if (explicitlyDiscontinued) status = "Explicitly discontinued";
    else if (last && latest && last.id !== latest.id) status = "Not listed in latest record";
    else if (occurrences.length > 1) status = "Continued in latest record";
    return {
      name: medication.name,
      firstDocumented: first?.dateLabel || MISSING,
      lastDocumented: last?.dateLabel || MISSING,
      occurrences: occurrences.length,
      status,
      latestDetails: medicationDisplay(last?.medications.find((item) => normalizedMedicationKey(item) === key) || medication),
      evidence: occurrences.map(recordEvidence),
    };
  });

  const investigationEntries = records.flatMap((record) => record.investigations.map((investigation) => ({ ...investigation, dateLabel: record.dateLabel, recordId: record.id })));
  const repeatedInvestigations = [...new Set(investigationEntries.map((item) => normalizedInvestigationKey(item)).filter(Boolean))]
    .filter((key) => investigationEntries.filter((item) => normalizedInvestigationKey(item) === key).length > 1)
    .map((key) => investigationEntries.find((item) => normalizedInvestigationKey(item) === key)?.testName || key);
  const latestKeysBeforeVisit = new Set(records.slice(0, -1).flatMap((record) => record.investigations.map(normalizedInvestigationKey)));
  const newInvestigations = latest ? latest.investigations.filter((item) => !latestKeysBeforeVisit.has(normalizedInvestigationKey(item))).map(investigationDisplay) : [];
  const importantResults = investigationEntries
    .filter((item) => item.resultValue || ["HIGH", "LOW", "CRITICAL"].includes(item.status))
    .filter((item) => item.status !== "UNKNOWN" || item.resultValue)
    .map((item) => `${item.dateLabel}: ${investigationDisplay(item)}`);

  const changesOverTime = [];
  for (let index = 1; index < records.length; index += 1) {
    const pairChanges = compareRecordChanges(records[index - 1], records[index]);
    pairChanges.forEach((change) => changesOverTime.push(`${records[index].dateLabel}: ${change}`));
  }
  const visitComparisons = [];
  for (let index = 1; index < records.length; index += 1) {
    const previousVisit = records[index - 1];
    const currentVisit = records[index];
    visitComparisons.push({
      previous: {
        dateLabel: previousVisit.dateLabel,
        title: previousVisit.title,
        evidence: recordEvidence(previousVisit),
        diagnoses: previousVisit.diagnoses.length ? previousVisit.diagnoses : [MISSING],
        medications: previousVisit.medications.length ? previousVisit.medications.map(medicationDisplay) : [MISSING],
        investigations: previousVisit.investigations.length ? previousVisit.investigations.map(investigationDisplay) : [MISSING],
      },
      current: {
        dateLabel: currentVisit.dateLabel,
        title: currentVisit.title,
        evidence: recordEvidence(currentVisit),
        diagnoses: currentVisit.diagnoses.length ? currentVisit.diagnoses : [MISSING],
        medications: currentVisit.medications.length ? currentVisit.medications.map(medicationDisplay) : [MISSING],
        investigations: currentVisit.investigations.length ? currentVisit.investigations.map(investigationDisplay) : [MISSING],
      },
      sections: compareRecordSections(previousVisit, currentVisit),
      changes: compareRecordChanges(previousVisit, currentVisit).length ? compareRecordChanges(previousVisit, currentVisit) : [MISSING],
    });
  }

  const timeline = records.map((record, index) => ({
    ...record,
    visitNumber: index + 1,
    current: index === records.length - 1,
    diagnosis: record.diagnoses.length ? record.diagnoses : [MISSING],
    medications: record.medications.length ? record.medications.map(medicationDisplay) : [MISSING],
    investigations: record.investigations.length ? record.investigations.map(investigationDisplay) : [MISSING],
    notes: record.notes.length ? record.notes : [MISSING],
    evidence: recordEvidence(record),
  }));
  const firstDate = records[0]?.dateLabel || MISSING;
  const lastDate = latest?.dateLabel || MISSING;
  const diagnosisText = diagnoses.length ? diagnoses.slice(0, 3).join(", ") : MISSING;
  const latestActivity = latest
    ? [
      latest.medications.length ? `${latest.medications.length} medication(s)` : "no medication documented",
      latest.investigations.length ? `${latest.investigations.length} investigation(s)` : "no investigation documented",
    ].join(" and ")
    : MISSING;
  const patientName = text(patient.fullName) || "This patient";
  const atAGlance = records.length
    ? `${patientName} has ${records.length} recorded clinical visit${records.length === 1 ? "" : "s"} from ${firstDate} to ${lastDate}. The records document ${diagnosisText}. The latest visit documents ${latestActivity}.`
    : `${patientName} has no verified clinical visits. Clinical history, medication history, investigation history, and changes over time are ${MISSING.toLowerCase()}`;

  return {
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
    modelName: "source-grounded longitudinal synthesis",
    sourceRecordCount: records.length,
    sourceRecordIds: records.map((record) => record.sourceRecordId),
    sourceFingerprint: sourceFingerprint(medicalRecords),
    atAGlance,
    overview: {
      patientName: patientName || MISSING,
      patientId: text(patient.mrn) || MISSING,
      age: patient.age === null || patient.age === undefined || patient.age === "" ? MISSING : String(patient.age),
      gender: text(patient.gender) || MISSING,
      totalVisits: records.length,
      firstRecordedVisit: firstDate,
      mostRecentVisit: lastDate,
    },
    clinicalHistory: {
      diagnoses: diagnoses.length ? diagnoses : [MISSING],
      recurringComplaints: complaints.length ? complaints : [MISSING],
      symptomsObservations: observations.length ? observations : [MISSING],
      documentedNotes: documentedNotes.length ? documentedNotes : [MISSING],
      investigations: investigationEntries.length ? unique(investigationEntries.map((item) => item.testName)) : [MISSING],
      documentedResults: importantResults.length ? unique(importantResults) : [MISSING],
    },
    medicationHistory: {
      previouslyPrescribed: allMedications.length ? allMedications.map(medicationDisplay) : [MISSING],
      currentlyDocumented: currentMedications.length ? currentMedications.map(medicationDisplay) : [MISSING],
      added: addedMedications.length ? addedMedications : [MISSING],
      discontinued: unique(discontinuations).length ? unique(discontinuations) : [MISSING],
      dosageChanges: dosageChanges.length ? unique(dosageChanges) : [MISSING],
      medicationTimeline: medicationTimeline.length ? medicationTimeline : [],
    },
    investigationHistory: {
      previousInvestigations: investigationEntries.length ? unique(investigationEntries.map((item) => item.testName)) : [MISSING],
      repeatedInvestigations: repeatedInvestigations.length ? repeatedInvestigations : [MISSING],
      importantResults: importantResults.length ? unique(importantResults) : [MISSING],
      newInvestigations: newInvestigations.length ? newInvestigations : [MISSING],
    },
    changesOverTime: changesOverTime.length ? unique(changesOverTime) : [MISSING],
    changesSincePreviousVisit: previous ? compareRecordChanges(previous, latest) : [MISSING],
    visitComparisons,
    sourceEvidence: records.map(recordEvidence),
    recentHistory: timeline.slice(-3).reverse(),
    timeline: timeline.reverse(),
  };
}

module.exports = { MISSING, buildPatientHistoryIntelligence, sourceFingerprint };
