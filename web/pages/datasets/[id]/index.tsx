import { ReactElement } from "react";
import AuthLayout from "../../../components/layout/auth/authLayout";
import DatasetIdPage from "../../../components/templates/datasets/datasetsIdPage";
import { withAuthSSR } from "../../../lib/api/handlerWrappers";

interface DatasetProps {
  id: string;
  currentPage: number;
  pageSize: number;
}

const Dataset = (props: DatasetProps) => {
  const { id, currentPage, pageSize } = props;

  return (
    <DatasetIdPage id={id} currentPage={currentPage} pageSize={pageSize} />
  );
};

export default Dataset;

Dataset.getLayout = function getLayout(page: ReactElement) {
  return <AuthLayout>{page}</AuthLayout>;
};

export const getServerSideProps = withAuthSSR(async (options) => {
  const { page, page_size } = options.context.query;

  const currentPage = parseInt(page as string, 10) || 1;
  const pageSize = parseInt(page_size as string, 10) || 25;
  const id = options.context.params?.id as string;

  return {
    props: {
      id,
      currentPage,
      pageSize,
    },
  };
});
