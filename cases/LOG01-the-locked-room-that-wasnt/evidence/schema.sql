-- LOG01 evidence schema (create table statements only), imported from the supplied seed and schema files

create table evidence_phase_1 (
  evidence_id text primary key,
  title text not null,
  source_label text not null,
  body text not null
);

create table evidence_phase_2 (
  evidence_id text primary key,
  title text not null,
  source_label text not null,
  body text not null
);

create table evidence_phase_3 (
  evidence_id text primary key,
  title text not null,
  source_label text not null,
  body text not null
);
