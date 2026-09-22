/**
 * DSA Clinical Search Engine
 * High-performance, typo-tolerant in-memory search engine powered by:
 * 1. Trie (Prefix Tree) — O(L) prefix autocomplete for names, MRNs, medications, and labs
 * 2. Inverted Index — Token-to-Posting mapping with field-weight scoring
 * 3. Levenshtein Distance (Wagner-Fischer DP) — Typo-tolerance & "Did you mean?" suggestions
 * 4. KMP (Knuth-Morris-Pratt) Algorithm — Substring snippet search in clinical text
 * 5. Max-Heap / Priority Queue — Top-K scored retrieval in O(N log K)
 * 6. LRU Cache — O(1) Hash Map + Doubly Linked List caching for instant repeat lookups
 */

// ============================================================================
// 1. LRU CACHE (Hash Map + Doubly Linked List)
// ============================================================================
class DoublyLinkedListNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

class LRUCache {
  constructor(capacity = 250) {
    this.capacity = capacity;
    this.map = new Map();
    this.head = new DoublyLinkedListNode(null, null); // Dummy head
    this.tail = new DoublyLinkedListNode(null, null); // Dummy tail
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  _remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _add(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const node = this.map.get(key);
    this._remove(node);
    this._add(node);
    return node.value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      const node = this.map.get(key);
      node.value = value;
      this._remove(node);
      this._add(node);
      return;
    }

    if (this.map.size >= this.capacity) {
      // Evict least recently used (node before tail)
      const lru = this.tail.prev;
      this._remove(lru);
      this.map.delete(lru.key);
    }

    const newNode = new DoublyLinkedListNode(key, value);
    this.map.set(key, newNode);
    this._add(newNode);
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
}

// ============================================================================
// 2. TRIE (Prefix Tree for O(L) Autocomplete & Exact Matches)
// ============================================================================
class TrieNode {
  constructor() {
    this.children = new Map();
    this.isTerminal = false;
    this.items = []; // References to entities ending at or passing through
  }
}

class ClinicalTrie {
  constructor() {
    this.root = new TrieNode();
    this.allWords = new Set();
  }

  insert(phrase, itemRef) {
    if (!phrase || typeof phrase !== 'string') return;
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) return;

    this.allWords.add(normalized);
    let curr = this.root;

    for (const ch of normalized) {
      if (!curr.children.has(ch)) {
        curr.children.set(ch, new TrieNode());
      }
      curr = curr.children.get(ch);
      // Keep lightweight reference at nodes for faster prefix scanning
      if (curr.items.length < 25 && !curr.items.some(x => x.id === itemRef.id)) {
        curr.items.push(itemRef);
      }
    }

    curr.isTerminal = true;
    if (!curr.items.some(x => x.id === itemRef.id)) {
      curr.items.push(itemRef);
    }
  }

  searchPrefix(prefix, maxResults = 10) {
    if (!prefix) return [];
    const normalized = prefix.trim().toLowerCase();
    let curr = this.root;

    for (const ch of normalized) {
      if (!curr.children.has(ch)) return [];
      curr = curr.children.get(ch);
    }

    return curr.items.slice(0, maxResults);
  }

  removeItem(itemId) {
    const removeFrom = (node) => {
      node.items = node.items.filter((item) => item.id !== itemId);
      for (const [character, child] of node.children) {
        removeFrom(child);
        if (!child.children.size && !child.items.length && !child.isTerminal) {
          node.children.delete(character);
        }
      }
    };
    removeFrom(this.root);
  }
}

// ============================================================================
// 3. LEVENSHTEIN DISTANCE (Wagner-Fischer Dynamic Programming)
// ============================================================================
class LevenshteinMatcher {
  /**
   * Computes edit distance between two strings using DP Matrix
   * Time Complexity: O(M * N), Space Complexity: O(min(M, N))
   */
  static distance(s1, s2) {
    const a = s1.toLowerCase();
    const b = s2.toLowerCase();
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let prevRow = [];
    for (let j = 0; j <= b.length; j++) prevRow[j] = j;

    for (let i = 1; i <= a.length; i++) {
      let currRow = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        currRow[j] = Math.min(
          currRow[j - 1] + 1,      // insertion
          prevRow[j] + 1,          // deletion
          prevRow[j - 1] + cost    // substitution
        );
      }
      prevRow = currRow;
    }

    return prevRow[b.length];
  }

  /**
   * Find closest dictionary word within threshold
   */
  static findClosest(query, dictionarySet, maxDistance = 2) {
    const q = query.trim().toLowerCase();
    if (!q || q.length < 3) return null;

    let closestWord = null;
    let minDistance = maxDistance + 1;

    for (const word of dictionarySet) {
      if (Math.abs(word.length - q.length) > maxDistance) continue;
      const dist = LevenshteinMatcher.distance(q, word);
      if (dist < minDistance && dist <= maxDistance) {
        minDistance = dist;
        closestWord = word;
        if (dist === 1) break; // Found very close match
      }
    }

    return closestWord ? { word: closestWord, distance: minDistance } : null;
  }
}

// ============================================================================
// 4. KMP (Knuth-Morris-Pratt Substring Matching Algorithm)
// ============================================================================
class KMPMatcher {
  /**
   * Computes the Prefix Function (pi table) in O(M) time
   */
  static computePi(pattern) {
    const m = pattern.length;
    const pi = new Array(m).fill(0);
    let k = 0;
    for (let q = 1; q < m; q++) {
      while (k > 0 && pattern[k] !== pattern[q]) {
        k = pi[k - 1];
      }
      if (pattern[k] === pattern[q]) {
        k++;
      }
      pi[q] = k;
    }
    return pi;
  }

  /**
   * Searches for pattern in text in O(N + M) time without backtracking
   */
  static search(pattern, text) {
    if (!pattern || !text) return false;
    const p = pattern.toLowerCase();
    const t = text.toLowerCase();
    const m = p.length;
    const n = t.length;
    if (m === 0) return true;
    if (n < m) return false;

    const pi = KMPMatcher.computePi(p);
    let q = 0;
    for (let i = 0; i < n; i++) {
      while (q > 0 && p[q] !== t[i]) {
        q = pi[q - 1];
      }
      if (p[q] === t[i]) {
        q++;
      }
      if (q === m) {
        return true; // Match found at index (i - m + 1)
      }
    }
    return false;
  }
}

// ============================================================================
// 5. MAX-HEAP / PRIORITY QUEUE (Top-K Scored Results)
// ============================================================================
class MaxHeap {
  constructor() {
    this.heap = [];
  }

  _parent(i) { return Math.floor((i - 1) / 2); }
  _leftChild(i) { return 2 * i + 1; }
  _rightChild(i) { return 2 * i + 2; }

  _swap(i, j) {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }

  push(item) {
    this.heap.push(item);
    this._siftUp(this.heap.length - 1);
  }

  _siftUp(i) {
    while (i > 0 && this.heap[this._parent(i)].score < this.heap[i].score) {
      this._swap(this._parent(i), i);
      i = this._parent(i);
    }
  }

  pop() {
    if (this.heap.length === 0) return null;
    if (this.heap.length === 1) return this.heap.pop();

    const root = this.heap[0];
    this.heap[0] = this.heap.pop();
    this._siftDown(0);
    return root;
  }

  _siftDown(i) {
    let maxIndex = i;
    const left = this._leftChild(i);
    const right = this._rightChild(i);

    if (left < this.heap.length && this.heap[left].score > this.heap[maxIndex].score) {
      maxIndex = left;
    }
    if (right < this.heap.length && this.heap[right].score > this.heap[maxIndex].score) {
      maxIndex = right;
    }

    if (i !== maxIndex) {
      this._swap(i, maxIndex);
      this._siftDown(maxIndex);
    }
  }

  size() {
    return this.heap.length;
  }
}

// ============================================================================
// 6. INVERTED INDEX (Token Map -> Postings with Relevance Scoring)
// ============================================================================
class InvertedIndex {
  constructor() {
    this.index = new Map(); // token -> Map<entityId, Posting>
    this.docCount = 0;
  }

  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !this._isStopWord(t));
  }

  _isStopWord(word) {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'from', 'was', 'were', 'that', 'this', 'are', 'has', 'have'
    ]);
    return stopWords.has(word);
  }

  add(entityId, entityRef, fieldName, text, weight = 1.0) {
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      if (!this.index.has(token)) {
        this.index.set(token, new Map());
      }
      const postings = this.index.get(token);
      if (!postings.has(entityId)) {
        postings.set(entityId, {
          entity: entityRef,
          score: 0,
          matchedFields: new Set(),
        });
      }
      const post = postings.get(entityId);
      post.score += weight;
      post.matchedFields.add(fieldName);
    }
  }

  lookup(tokens) {
    if (!tokens || tokens.length === 0) return [];
    const entityScores = new Map();

    for (const token of tokens) {
      const postings = this.index.get(token);
      if (!postings) continue;

      for (const [entityId, post] of postings.entries()) {
        if (!entityScores.has(entityId)) {
          entityScores.set(entityId, {
            entity: post.entity,
            score: 0,
            matchedFields: new Set(),
            tokenHits: 0,
          });
        }
        const acc = entityScores.get(entityId);
        acc.score += post.score;
        acc.tokenHits += 1;
        post.matchedFields.forEach(f => acc.matchedFields.add(f));
      }
    }

    // Boost documents matching all query tokens
    const results = [];
    for (const acc of entityScores.values()) {
      if (acc.tokenHits === tokens.length) {
        acc.score *= 1.5; // Multi-token intersection boost
      }
      results.push(acc);
    }

    return results;
  }
}

// ============================================================================
// 7. COMPREHENSIVE CLINICAL SEARCH ENGINE
// ============================================================================
class ClinicalSearchEngine {
  constructor() {
    this.trie = new ClinicalTrie();
    this.invertedIndex = new InvertedIndex();
    this.lruCache = new LRUCache(300);
    this.entityStore = new Map(); // entityId -> raw entity
    this.knownDocIds = new Set(); // ObjectId strings of docs currently indexed
    this.knownSubEntityIds = new Set(); // live med_/lab_ entity ids
    this.subEntitiesByDoc = new Map(); // docKey -> Set<subEntityId> for O(1) purge
    this.isIndexed = false;
    this.stats = {
      totalEntities: 0,
      totalTokens: 0,
      lastIndexedAt: null,
    };
  }

  /**
   * Build complete index from MongoDB models
   */
  async buildIndex({ patients = [], documents = [], records = [] }) {
    const startTime = Date.now();
    this.trie = new ClinicalTrie();
    this.invertedIndex = new InvertedIndex();
    this.entityStore.clear();
    this.lruCache.clear();
    this.knownDocIds.clear();
    this.knownSubEntityIds.clear();
    this.subEntitiesByDoc.clear();

    // 1. Index Patients
    for (const p of patients) {
      this._indexPatientEntity(p);
    }

    // 2. Index Clinical Documents (OCR, Medications, Labs)
    for (const d of documents) {
      this._indexDocumentEntity(d);
    }

    // 3. Index Medical Records (Verified & Versioned History)
    for (const r of records) this._indexRecordEntity(r);

    this.isIndexed = true;
    this.stats = {
      totalEntities: this.entityStore.size,
      totalTokens: this.invertedIndex.index.size,
      lastIndexedAt: new Date(),
      buildDurationMs: Date.now() - startTime,
    };

    return this.stats;
  }

  /**
   * Indexes one patient entity into Trie, Inverted Index, and entityStore.
   */
  _indexPatientEntity(p) {
    if (!p || !p._id) return;
    const id = `patient_${p._id}`;
    const ref = {
      id,
      entityType: 'PATIENT',
      title: p.fullName,
      subtitle: `MRN: ${p.mrn} · ${p.age || '—'}y, ${p.gender || 'N/A'} · Blood: ${p.bloodGroup || '—'}`,
      url: `/patients/${p._id}`,
      badge: 'Patient',
      meta: { mrn: p.mrn, phone: p.phone, allergies: p.allergies },
      createdAt: p.createdAt || new Date(),
    };
    this.entityStore.set(id, ref);

    // Trie indexing
    this.trie.insert(p.fullName, ref);
    this.trie.insert(p.mrn, ref);
    if (p.phone) this.trie.insert(p.phone, ref);

    // Inverted index
    this.invertedIndex.add(id, ref, 'fullName', p.fullName, 5.0);
    this.invertedIndex.add(id, ref, 'mrn', p.mrn, 6.0);
    this.invertedIndex.add(id, ref, 'allergies', p.allergies || '', 2.0);
    this.invertedIndex.add(id, ref, 'chronicConditions', p.chronicConditions || '', 2.0);
  }

  /**
   * Incrementally upsert one patient (create / update / match paths).
   */
  indexSinglePatient(p) {
    if (!p || !p._id) return null;
    const id = `patient_${p._id}`;
    // Scrub old postings if already present
    for (const [token, postings] of this.invertedIndex.index) {
      if (postings.delete(id) && postings.size === 0) this.invertedIndex.index.delete(token);
    }
    this.trie.removeItem(id);
    this._indexPatientEntity(p);
    this.lruCache.clear();
    this.stats.totalEntities = this.entityStore.size;
    this.stats.totalTokens = this.invertedIndex.index.size;
    this.stats.lastIndexedAt = new Date();
    this.isIndexed = true;
    return { id, totalEntities: this.entityStore.size, totalTokens: this.invertedIndex.index.size };
  }

  /**
   * Indexes one clinical document into the existing structures. Shared by the
   * full rebuild and incremental single-document updates after upload/verify.
   * Time: O(document content) instead of a full O(total entities) rebuild.
   */
  _indexDocumentEntity(d) {
    if (!d || !d._id) return;
    const id = `doc_${d._id}`;
    const docKey = String(d._id);
    const subEntityIds = new Set();
    this.subEntitiesByDoc.set(docKey, subEntityIds);
    const patientName = d.patient?.fullName || 'Assigned Patient';
    const ref = {
      id,
      entityType: 'DOCUMENT',
      title: d.originalFilename,
      subtitle: `${d.documentType} · Status: ${d.status} · Patient: ${patientName}`,
      url: `/review/${d._id}`,
      badge: 'Clinical Document',
      meta: {
        documentType: d.documentType,
        status: d.status,
        medicationsCount: d.medications?.length || 0,
        labsCount: d.labResults?.length || 0,
      },
      createdAt: d.createdAt || new Date(),
    };
    this.entityStore.set(id, ref);
    this.knownDocIds.add(String(d._id));

    // Trie indexing
    this.trie.insert(d.originalFilename, ref);
    this.trie.insert(d.documentType, ref);

    // Inverted index
    this.invertedIndex.add(id, ref, 'filename', d.originalFilename, 4.0);
    this.invertedIndex.add(id, ref, 'documentType', d.documentType, 3.5);

    // Index extracted medications
    if (Array.isArray(d.medications)) {
      for (const med of d.medications) {
        const medId = `med_${d._id}_${med.name}`;
        subEntityIds.add(medId);
        this.knownSubEntityIds.add(medId);
        const medRef = {
          id: medId,
          entityType: 'MEDICATION',
          title: `Rx: ${med.name} ${med.dosage || ''}`,
          subtitle: `${med.frequency || 'As instructed'} · ${med.isVerified ? 'Doctor Verified' : 'AI Extracted'} (${patientName})`,
          url: `/review/${d._id}`,
          badge: 'Medication',
          meta: { dosage: med.dosage, frequency: med.frequency, isVerified: med.isVerified },
          createdAt: d.createdAt || new Date(),
        };
        this.trie.insert(med.name, medRef);
        if (med.genericName) this.trie.insert(med.genericName, medRef);
        this.invertedIndex.add(medId, medRef, 'medication', `${med.name} ${med.genericName || ''} ${med.dosage || ''}`, 4.5);
      }
    }

    // Index extracted lab tests
    if (Array.isArray(d.labResults)) {
      for (const lab of d.labResults) {
        const labId = `lab_${d._id}_${lab.testName}`;
        subEntityIds.add(labId);
        this.knownSubEntityIds.add(labId);
        const labRef = {
          id: labId,
          entityType: 'LAB_TEST',
          title: `${lab.testName}: ${lab.resultValue} ${lab.units || ''}`,
          subtitle: `Status: ${lab.status} · Ref: ${lab.referenceRange || 'N/A'} (${patientName})`,
          url: `/review/${d._id}`,
          badge: 'Lab Investigation',
          meta: { status: lab.status, resultValue: lab.resultValue, referenceRange: lab.referenceRange },
          createdAt: d.createdAt || new Date(),
        };
        this.trie.insert(lab.testName, labRef);
        this.invertedIndex.add(labId, labRef, 'labTest', `${lab.testName} ${lab.resultValue} ${lab.status}`, 4.0);
      }
    }
  }

  /**
   * Incrementally upsert one document (upload / verify / reject paths).
   * Avoids the previous full-index rebuild per mutation.
   */
  indexSingleDocument(d) {
    if (!d || !d._id) return null;
    this.removeDocument(d._id); // idempotent replace
    this._indexDocumentEntity(d);
    this.lruCache.clear();
    this.stats.totalEntities = this.entityStore.size;
    this.stats.totalTokens = this.invertedIndex.index.size;
    this.stats.lastIndexedAt = new Date();
    this.isIndexed = true;
    return { id: `doc_${d._id}`, totalEntities: this.entityStore.size, totalTokens: this.invertedIndex.index.size };
  }

  /**
   * Incrementally upsert one medical record (amendment / seal paths).
   */
  indexSingleRecord(r) {
    if (!r || !r._id) return null;
    this.removeRecord(r._id);
    this._indexRecordEntity(r);
    this.lruCache.clear();
    this.stats.totalEntities = this.entityStore.size;
    this.stats.totalTokens = this.invertedIndex.index.size;
    this.stats.lastIndexedAt = new Date();
    this.isIndexed = true;
    return { id: `rec_${r._id}`, totalEntities: this.entityStore.size, totalTokens: this.invertedIndex.index.size };
  }

  /**
   * Removes a document and its medication/lab sub-entities from the index.
   */
  removeDocument(documentId) {
    const id = `doc_${documentId}`;
    const subIds = this.subEntitiesByDoc.get(String(documentId)) || new Set();
    if (!this.entityStore.has(id) && !this.knownDocIds.has(String(documentId)) && !subIds.size) return false;
    this.entityStore.delete(id);
    this.knownDocIds.delete(String(documentId));
    // Purge every med_/lab_ sub-entity that belonged to this document
    for (const subId of subIds) {
      this.knownSubEntityIds.delete(subId);
      this._removeEntityPostings(subId);
      this.trie.removeItem(subId);
    }
    this.subEntitiesByDoc.delete(String(documentId));
    // Scrub postings that belong to the removed document
    this._removeEntityPostings(id);
    this.trie.removeItem(id);
    this.lruCache.clear();
    this.stats.totalEntities = this.entityStore.size;
    this.stats.totalTokens = this.invertedIndex.index.size;
    return true;
  }

  _removeEntityPostings(entityId) {
    for (const [token, postings] of this.invertedIndex.index) {
      if (postings.delete(entityId) && postings.size === 0) this.invertedIndex.index.delete(token);
    }
  }

  _indexRecordEntity(r) {
    if (!r || !r._id) return;
    const id = `rec_${r._id}`;
    const patientName = r.patient?.fullName || 'Verified Patient';
    const ref = {
      id,
      entityType: 'RECORD',
      title: r.title,
      subtitle: `v${r.version || 1} · Verified by ${r.verifiedByName || 'Attending Physician'} · ${patientName}`,
      url: `/records/${r._id}`,
      badge: 'Medical Record',
      meta: { version: r.version, verifiedBy: r.verifiedByName, clinicName: r.clinicName },
      createdAt: r.createdAt || new Date(),
    };
    this.entityStore.set(id, ref);
    this.trie.insert(r.title, ref);
    this.invertedIndex.add(id, ref, 'title', r.title, 5.0);
    this.invertedIndex.add(id, ref, 'recordType', r.recordType || '', 3.0);
    if (r.verificationNotes) this.invertedIndex.add(id, ref, 'verificationNotes', r.verificationNotes, 2.5);
  }

  removeRecord(recordId) {
    const id = `rec_${recordId}`;
    if (!this.entityStore.has(id)) return false;
    this.entityStore.delete(id);
    this._removeEntityPostings(id);
    this.trie.removeItem(id);
    this.lruCache.clear();
    this.stats.totalEntities = this.entityStore.size;
    this.stats.totalTokens = this.invertedIndex.index.size;
    return true;
  }

  /**
   * Trie and inverted-index entries for med_/lab_ sub-entities are inserted
   * once and never rewritten in place, so removals are filtered lazily at
   * query time via knownDocIds. O(1) per candidate.
   */
  _isLiveEntity(entityId) {
    const idStr = String(entityId);
    if (idStr.startsWith('doc_')) return this.knownDocIds.has(idStr.slice(4));
    if (idStr.startsWith('med_') || idStr.startsWith('lab_')) {
      return this.knownSubEntityIds.has(idStr);
    }
    return this.entityStore.has(idStr);
  }

  /**
   * Search query execution using DSA pipeline
   */
  search(rawQuery, options = {}) {
    const startTime = process.hrtime.bigint();
    const query = String(rawQuery || '').trim();
    const categoryFilter = options.category || 'ALL'; // ALL, PATIENT, MEDICATION, LAB_TEST, DOCUMENT, RECORD
    const limit = Math.min(Number(options.limit) || 20, 50);

    if (!query) {
      return {
        query: '',
        results: [],
        total: 0,
        facets: { ALL: 0, PATIENT: 0, MEDICATION: 0, LAB_TEST: 0, DOCUMENT: 0, RECORD: 0 },
        appliedAlgorithm: 'NONE',
        executionTimeMs: 0,
        suggestedQuery: null,
      };
    }

    // Check LRU Cache
    const cacheKey = `${query.toLowerCase()}::${categoryFilter}::${limit}`;
    const cached = this.lruCache.get(cacheKey);
    if (cached) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      return {
        ...cached,
        fromCache: true,
        executionTimeMs: Number(durationMs.toFixed(3)),
      };
    }

    const scoredMap = new Map(); // entityId -> { entity, score, matchAlgorithm, matchedFields }
    let primaryAlgorithm = 'DSA_HYBRID';

    // A. Trie Prefix Matching
    const trieMatches = this.trie.searchPrefix(query, 30);
    for (const item of trieMatches) {
      if (!scoredMap.has(item.id)) {
        scoredMap.set(item.id, {
          entity: item,
          score: 100.0, // High priority for exact prefix
          matchAlgorithm: 'TRIE_PREFIX',
          matchedFields: ['prefix'],
        });
      }
    }

    // B. Inverted Index Token Matching
    const tokens = this.invertedIndex.tokenize(query);
    const invertedMatches = this.invertedIndex.lookup(tokens);
    for (const match of invertedMatches) {
      if (!scoredMap.has(match.entity.id)) {
        scoredMap.set(match.entity.id, {
          entity: match.entity,
          score: match.score * 10,
          matchAlgorithm: 'INVERTED_INDEX',
          matchedFields: Array.from(match.matchedFields),
        });
      } else {
        const existing = scoredMap.get(match.entity.id);
        existing.score += match.score * 5;
        match.matchedFields.forEach(f => existing.matchedFields.push(f));
      }
    }

    // C. Levenshtein Fuzzy Typo Check (if low matches)
    let suggestedQuery = null;
    if (scoredMap.size === 0 && query.length >= 3) {
      const closest = LevenshteinMatcher.findClosest(query, this.trie.allWords, 2);
      if (closest && closest.word !== query.toLowerCase()) {
        suggestedQuery = closest.word;
        // Search with suggested word
        const fuzzyMatches = this.trie.searchPrefix(closest.word, 20);
        for (const item of fuzzyMatches) {
          scoredMap.set(item.id, {
            entity: item,
            score: 75.0 - (closest.distance * 15),
            matchAlgorithm: `FUZZY_LEVENSHTEIN (d=${closest.distance})`,
            matchedFields: ['fuzzy'],
          });
        }
        primaryAlgorithm = `FUZZY_LEVENSHTEIN (d=${closest.distance})`;
      }
    }

    // D. KMP Substring Matching across raw text for precision
    for (const [entityId, entity] of this.entityStore.entries()) {
      if (!scoredMap.has(entityId) && KMPMatcher.search(query, `${entity.title} ${entity.subtitle}`)) {
        scoredMap.set(entityId, {
          entity,
          score: 40.0,
          matchAlgorithm: 'KMP_SUBSTRING',
          matchedFields: ['substring'],
        });
      }
    }

    // Lazy tombstone filtering: trie/inverted-index entries of removed
    // documents are dropped at query time in O(candidates).
    for (const entityId of Array.from(scoredMap.keys())) {
      if (!this._isLiveEntity(entityId)) scoredMap.delete(entityId);
    }

    // E. Max-Heap for Top-K extraction
    const maxHeap = new MaxHeap();
    const facets = { ALL: 0, PATIENT: 0, MEDICATION: 0, LAB_TEST: 0, DOCUMENT: 0, RECORD: 0 };

    for (const item of scoredMap.values()) {
      const entityType = item.entity.entityType;
      facets.ALL++;
      if (facets[entityType] !== undefined) {
        facets[entityType]++;
      }

      // Apply category filter if requested
      if (categoryFilter !== 'ALL' && entityType !== categoryFilter) {
        continue;
      }

      maxHeap.push(item);
    }

    const sortedResults = [];
    while (maxHeap.size() > 0 && sortedResults.length < limit) {
      const top = maxHeap.pop();
      sortedResults.push({
        ...top.entity,
        score: Math.round(top.score),
        matchAlgorithm: top.matchAlgorithm,
        matchedFields: top.matchedFields,
      });
    }

    const endTime = process.hrtime.bigint();
    const executionTimeMs = Number((Number(endTime - startTime) / 1e6).toFixed(3));

    const response = {
      query,
      results: sortedResults,
      total: sortedResults.length,
      facets,
      appliedAlgorithm: primaryAlgorithm,
      executionTimeMs,
      suggestedQuery,
      fromCache: false,
    };

    // Store in LRU Cache
    this.lruCache.set(cacheKey, response);
    return response;
  }
}

// Export singleton instance and individual classes
const clinicalSearchEngine = new ClinicalSearchEngine();

module.exports = {
  clinicalSearchEngine,
  ClinicalSearchEngine,
  ClinicalTrie,
  InvertedIndex,
  LevenshteinMatcher,
  KMPMatcher,
  MaxHeap,
  LRUCache,
};
