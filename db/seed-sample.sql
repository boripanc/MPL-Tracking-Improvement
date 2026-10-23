-- Sample data for local development and tests (npm run db:seed). Do not run against production.

INSERT INTO error_category (category_name, category_expression) VALUES
  ('Mapping Failed', 'com.sap.xi.mapping.camel.XiMappingException'),
  ('Connection Timeout', 'TimeoutException'),
  ('Process Corrupted', 'http:\/\/tue\.iot\.mww\.prod:84\/mwwapi\/api\/Works\/[^\/\s]+\/Close[\s\S]*?statusCode:\s*400'),
  ('Unable to send Email', 'com.sun.mail.smtp.SMTPSendFailedException');

INSERT INTO error_analyzed (errormessage, integration_flow_name, rootcause, solutions, status) VALUES
  ('org.apache.camel.component.ahc.AhcOperationFailedException: HTTP operation failed invoking http://tue.iot.mww.prod:84/mwwapi/api/Works/',
   'INT406_TUE_IOT_COMB', 'Process Interrupted', NULL, 'Open'),
  ('org.apache.camel.component.directvm.DirectVmConsumerNotAvailableException: No consumers available on endpoint: /SendAlertEmail. Exchange[]',
   'DELVRY07_IDOC_TO_PLANTWISE_ROUTING', 'Invalid IDOC Destination', NULL, 'Open'),
  ('org.apache.camel.component.file.GenericFileOperationFailedException: Cannot connect to sap-sftp://',
   'APAC_S4HANA_To_TUNARUN_Transaction_Outbound', 'SSH service on SFTP site stopped.', 'Contact the SFTP site owner to restart the SSH service.', 'Resolved');

INSERT INTO error_analyzed_comments (ea_id, comment) VALUES (1, 'Started investigating with the MWW team.');

WITH src (guid, corr, flow, pkg, status, mins_ago, msg) AS (VALUES
  ('MPL-0001', 'COR-01', 'INT406_TUE_IOT_COMB', 'TUE_IOT_TO_TUE_S4HANA_MANWINWIN', 'FAILED', 30,
   'org.apache.camel.component.ahc.AhcOperationFailedException: HTTP operation failed invoking http://tue.iot.mww.prod:84/mwwapi/api/Works/071268/Close with statusCode: 400'),
  ('MPL-0002', 'COR-01', 'INT401_TUE_IOT_MWW_To_TUE_S4HANA_Timer_Flow', 'TUE_S4HANA_WITH_MANWINWIN_IOT', 'FAILED', 31,
   'org.apache.camel.CamelExchangeException: Multicast processing failed for number 45. Exchange[975BD5282217700-0000000000000AC0]. Caused by: [org.apache.camel.component.ahc.AhcOperationFailedException - HTTP operation failed invoking http://tue.iot.mww.prod:84/mwwapi/api/Works/071268/Close with statusCode: 400]'),
  ('MPL-0003', 'COR-02', 'Common_Outbound_Acknowledgement_EDI997', 'TUNA_TPM_WITH_COSFF_CUSTOMERS', 'FAILED', 90,
   'org.apache.camel.language.xpath.InvalidXPathException: Invalid xpath: /BusinessTransactionActivity/PartnerIDHash. Reason: Content is not allowed in prolog.'),
  ('MPL-0004', 'COR-03', 'Common_Outbound_Acknowledgement_EDI997', 'TUNA_TPM_WITH_COSFF_CUSTOMERS', 'FAILED', 150,
   'org.apache.camel.language.xpath.InvalidXPathException: Invalid xpath: /BusinessTransactionActivity/PartnerIDHash. Reason: Content is not allowed in prolog.'),
  ('MPL-0005', 'COR-04', 'DELVRY07_IDOC_TO_PLANTWISE_ROUTING', 'COMMON_S4HANA_IDOC_To_Plantwise_Routing', 'ESCALATED', 200,
   'org.apache.camel.component.directvm.DirectVmConsumerNotAvailableException: No consumers available on endpoint: /SendAlertEmail. Exchange[]'),
  ('MPL-0006', 'COR-05', 'INT401_TUE_IOT_MWW_To_S4HANA_Notification_Creation_Inbound', 'TUE_IOT_TO_TUE_S4HANA_MANWINWIN', 'FAILED', 600,
   'java.util.concurrent.TimeoutException: Request timeout to 10.0.4.5/10.0.4.5:20003 after 60000 ms'),
  ('MPL-0007', 'COR-06', 'EPP_COMB2', 'EPP_TUE_S4HANA_WITH_TUE_MANWINWIN', 'FAILED', 1500,
   'com.sap.xi.mapping.camel.XiMappingException: Cannot produce target element /ns1:ZMMGR_BAPI_GOODSMVT_CREATE. Queue has not enough values in context.'),
  ('MPL-0008', 'COR-07', 'TUG_S4HANA_IDOC_ROUTING', '_COMMON_WITH_S4HANA', 'FAILED', 3000,
   'org.apache.camel.component.directvm.DirectVmConsumerNotAvailableException: No consumers available on endpoint: VMNotfound. Exchange[]'),
  ('MPL-0009', 'COR-08', 'APAC_S4HANA_To_TUNARUN_Transaction_Outbound', 'APAC_TUNARUN', 'FAILED', 20000,
   'org.apache.camel.component.file.GenericFileOperationFailedException: Cannot connect to sap-sftp://sftp_user@sftp.example:22, cause: java.net.SocketException: SOCKS5 command failed with status: HOST_UNREACHABLE'),
  ('MPL-0010', 'COR-09', 'TUG_S4HANA_IDOC_ROUTING', '_COMMON_WITH_S4HANA', 'ESCALATED', 120, NULL)
), ins AS (
  INSERT INTO message_processing_logs (message_guid, correlation_id, integration_flow_name, status, custom_status, log_start, log_end,
                                       artifact_details, raw, polled_at)
  SELECT guid, corr, flow, status, status, now() - make_interval(mins => mins_ago), now() - make_interval(mins => mins_ago) + interval '20 seconds',
         jsonb_build_object('Id', flow, 'Name', flow, 'PackageName', pkg),
         jsonb_build_object('MessageGuid', guid, 'AlternateWebLink', 'https://cpi.example/shell/monitoring/Messages/' || guid),
         now()
  FROM src RETURNING message_guid
)
INSERT INTO error_information (message_guid, hasvalue, errormsg)
SELECT s.guid, s.msg IS NOT NULL, s.msg FROM src s JOIN ins i ON i.message_guid = s.guid;

INSERT INTO customs_attributes (message_guid, ca_id, name, value) VALUES
  ('MPL-0001', '1', 'workorder', '071268'),
  ('MPL-0001', '2', 'MaterialNo', '100200300');
